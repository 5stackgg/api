import { Injectable, Logger } from "@nestjs/common";
import { ObjectInfo } from "minio/dist/main/internal/type";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "../../generated";
import { S3Service } from "../s3/s3.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";

// Where the latest scan report is persisted in the bucket. Kept in S3 (rather
// than a DB table) so the result survives restarts and is shared across API
// replicas without a schema change. This prefix is ignored by the scan itself.
const SCAN_RESULT_KEY = "scans/orphaned-objects.latest.json";

// Only objects under these prefixes are ever treated as deletable orphans.
// Anything else (including the db-backup bucket, which is a separate bucket) is
// reported as "other" and never marked for deletion.
const ORPHAN_PREFIXES = ["demos/", "clips/"];
const IGNORE_PREFIXES = ["scans/"];

const ORPHAN_SAMPLE_LIMIT = 250;

export type OrphanObject = {
  key: string;
  size: number;
};

export type OrphanScanResult = {
  scanned_at: string;
  bucket: string;
  total_objects: number;
  total_bytes: number;
  tracked_objects: number;
  tracked_bytes: number;
  // Tracked storage split by category (real S3 sizes), so the breakdown can be
  // compared against the panel's per-type cards. demos/ also covers playback
  // blobs; clips/ is highlights.
  demo_objects: number;
  demo_bytes: number;
  clip_objects: number;
  clip_bytes: number;
  orphan_objects: number;
  orphan_bytes: number;
  other_objects: number;
  other_bytes: number;
  orphans: OrphanObject[];
};

export type DeleteOrphansResult = {
  deleted: number;
  bytes_freed: number;
  remaining_orphans: number;
};

export type BackfillResult = {
  demos_updated: number;
  clips_updated: number;
};

@Injectable()
export class S3ScanService {
  private scanning = false;

  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {}

  public isScanning(): boolean {
    return this.scanning;
  }

  // Streams the entire bucket once, classifying every object against the set of
  // keys referenced in the database. Orphans are objects under demos/ or clips/
  // that no row points at — i.e. storage we are paying for but not tracking.
  public async scan(): Promise<OrphanScanResult> {
    if (this.scanning) {
      throw new Error("scan already in progress");
    }
    this.scanning = true;
    const startedAt = Date.now();
    try {
      const known = await this.loadKnownKeys();
      this.logger.log(
        `[s3-scan] loaded ${known.size} tracked keys from database`,
      );

      let totalObjects = 0;
      let totalBytes = 0;
      let trackedObjects = 0;
      let trackedBytes = 0;
      let demoObjects = 0;
      let demoBytes = 0;
      let clipObjects = 0;
      let clipBytes = 0;
      let otherObjects = 0;
      let otherBytes = 0;
      let orphanBytes = 0;
      const orphans: OrphanObject[] = [];
      // Captured during the same pass so we can reconcile the DB size columns
      // (which the panel sums) without a second listing — no separate action.
      const sizeByKey = new Map<string, number>();

      const stream = this.s3.listStream();
      for await (const entry of stream) {
        const obj = entry as ObjectInfo;
        const key = obj.name;
        if (!key) {
          continue;
        }
        const size = obj.size ?? 0;
        sizeByKey.set(key, size);
        totalObjects++;
        totalBytes += size;

        if (IGNORE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
          otherObjects++;
          otherBytes += size;
          continue;
        }

        if (known.has(key)) {
          trackedObjects++;
          trackedBytes += size;
          if (key.startsWith("demos/")) {
            demoObjects++;
            demoBytes += size;
          } else if (key.startsWith("clips/")) {
            clipObjects++;
            clipBytes += size;
          }
          continue;
        }

        if (ORPHAN_PREFIXES.some((prefix) => key.startsWith(prefix))) {
          orphans.push({ key, size });
          orphanBytes += size;
        } else {
          otherObjects++;
          otherBytes += size;
        }

        if (totalObjects % 5000 === 0) {
          this.logger.log(
            `[s3-scan] scanned ${totalObjects} objects so far (${orphans.length} orphans)`,
          );
        }
      }

      orphans.sort((a, b) => b.size - a.size);

      const result: OrphanScanResult = {
        scanned_at: new Date().toISOString(),
        bucket: this.s3.bucketName,
        total_objects: totalObjects,
        total_bytes: totalBytes,
        tracked_objects: trackedObjects,
        tracked_bytes: trackedBytes,
        demo_objects: demoObjects,
        demo_bytes: demoBytes,
        clip_objects: clipObjects,
        clip_bytes: clipBytes,
        orphan_objects: orphans.length,
        orphan_bytes: orphanBytes,
        other_objects: otherObjects,
        other_bytes: otherBytes,
        orphans,
      };

      await this.persistResult(result);

      // Reconcile DB size columns with real S3 sizes so the panel's totals stay
      // accurate — folded into the scan so there's no separate manual step.
      const reconciled = await this.reconcileSizes(sizeByKey);

      await this.notifyScanComplete(result);

      this.logger.log(
        `[s3-scan] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
          `${totalObjects} objects / ${this.formatSize(totalBytes)} total, ` +
          `tracked ${trackedObjects} / ${this.formatSize(trackedBytes)} ` +
          `(demos ${this.formatSize(demoBytes)}, highlights ${this.formatSize(clipBytes)}), ` +
          `orphaned ${orphans.length} / ${this.formatSize(orphanBytes)}, ` +
          `other ${otherObjects} / ${this.formatSize(otherBytes)}; ` +
          `reconciled ${reconciled.demos_updated} demo + ${reconciled.clips_updated} clip row(s)`,
      );

      return result;
    } finally {
      this.scanning = false;
    }
  }

  public async getResult(): Promise<OrphanScanResult | null> {
    if (!(await this.s3.has(SCAN_RESULT_KEY))) {
      return null;
    }
    const stream = await this.s3.get(SCAN_RESULT_KEY);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as OrphanScanResult;
  }

  // Deletes orphans found by the most recent scan. Every candidate is
  // re-checked against the database at delete time, so a key that became
  // tracked between scan and delete is left alone. An optional explicit key
  // list restricts deletion to that subset of the last scan's orphans.
  public async deleteOrphans(
    requestedKeys?: string[],
  ): Promise<DeleteOrphansResult> {
    const result = await this.getResult();
    if (!result) {
      throw new Error("no scan result found — run scanOrphanedDemos first");
    }

    const orphanSizes = new Map(result.orphans.map((o) => [o.key, o.size]));

    let targets = new Set(
      requestedKeys?.length
        ? requestedKeys.filter((key) => orphanSizes.has(key))
        : [...orphanSizes.keys()],
    );

    // Safety net: never delete outside the allowed prefixes, and re-verify
    // against the live DB in case a key was registered since the scan.
    const known = await this.loadKnownKeys();
    targets = new Set(
      [...targets].filter(
        (key) =>
          ORPHAN_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
          !known.has(key),
      ),
    );

    const targetKeys = [...targets];
    if (targetKeys.length === 0) {
      return {
        deleted: 0,
        bytes_freed: 0,
        remaining_orphans: result.orphans.length,
      };
    }

    const bytesFreed = targetKeys.reduce(
      (sum, key) => sum + (orphanSizes.get(key) ?? 0),
      0,
    );
    const deleted = await this.s3.removeKeys(targetKeys);

    result.orphans = result.orphans.filter((o) => !targets.has(o.key));
    result.orphan_objects = result.orphans.length;
    result.orphan_bytes = result.orphans.reduce((sum, o) => sum + o.size, 0);
    await this.persistResult(result);

    this.logger.log(
      `[s3-scan] deleted ${deleted} orphaned object(s), freed ${this.formatSize(bytesFreed)} ` +
        `(${result.orphans.length} orphans remaining)`,
    );

    return {
      deleted,
      bytes_freed: bytesFreed,
      remaining_orphans: result.orphans.length,
    };
  }

  // Reconciles the DB size columns with the real S3 object sizes so the panel's
  // storage totals stop under-counting. Takes the size map captured during the
  // scan's listing pass (no extra listing / no statting) and bulk-updates demos
  // (size + playback_size) and clips (file + thumbnail).
  private async reconcileSizes(
    sizeByKey: Map<string, number>,
  ): Promise<BackfillResult> {
    const demoIds: string[] = [];
    const demoSizes: Array<number | null> = [];
    const demoPlaybackSizes: Array<number | null> = [];
    const demos = await this.postgres.query<
      Array<{ id: string; file: string | null; playback_file: string | null }>
    >(`SELECT id, file, playback_file FROM public.match_map_demos`);
    for (const demo of demos) {
      const size =
        demo.file && sizeByKey.has(demo.file)
          ? (sizeByKey.get(demo.file) ?? null)
          : null;
      const playback =
        demo.playback_file && sizeByKey.has(demo.playback_file)
          ? (sizeByKey.get(demo.playback_file) ?? null)
          : null;
      if (size === null && playback === null) {
        continue;
      }
      demoIds.push(demo.id);
      demoSizes.push(size);
      demoPlaybackSizes.push(playback);
    }
    if (demoIds.length > 0) {
      await this.postgres.query(
        `UPDATE public.match_map_demos AS d
            SET size = COALESCE(v.size, d.size),
                playback_size = COALESCE(v.playback_size, d.playback_size)
           FROM UNNEST($1::uuid[], $2::bigint[], $3::bigint[])
             AS v(id, size, playback_size)
          WHERE d.id = v.id`,
        [demoIds, demoSizes, demoPlaybackSizes],
      );
    }

    const clipIds: string[] = [];
    const clipSizes: number[] = [];
    const clips = await this.postgres.query<
      Array<{ id: string; file: string | null; thumbnail_url: string | null }>
    >(`SELECT id, file, thumbnail_url FROM public.match_clips`);
    for (const clip of clips) {
      const fileSize =
        clip.file && sizeByKey.has(clip.file) ? sizeByKey.get(clip.file) : null;
      const thumbSize =
        clip.thumbnail_url && sizeByKey.has(clip.thumbnail_url)
          ? sizeByKey.get(clip.thumbnail_url)
          : null;
      if (fileSize === null && thumbSize === null) {
        continue;
      }
      clipIds.push(clip.id);
      clipSizes.push((fileSize ?? 0) + (thumbSize ?? 0));
    }
    if (clipIds.length > 0) {
      await this.postgres.query(
        `UPDATE public.match_clips AS c
            SET size = v.size
           FROM UNNEST($1::uuid[], $2::bigint[]) AS v(id, size)
          WHERE c.id = v.id`,
        [clipIds, clipSizes],
      );
    }

    return {
      demos_updated: demoIds.length,
      clips_updated: clipIds.length,
    };
  }

  private async notifyScanComplete(result: OrphanScanResult): Promise<void> {
    const found = result.orphan_objects > 0;
    const message = found
      ? `Found **${result.orphan_objects}** orphaned object(s) using **${this.formatSize(result.orphan_bytes)}** ` +
        `(demos ${this.formatSize(result.demo_bytes)}, highlights ${this.formatSize(result.clip_bytes)}). ` +
        `Open Demo Settings → Scan Orphaned Uploads to review and delete them.`
      : `No orphaned uploads found. Tracked ${this.formatSize(result.tracked_bytes)} ` +
        `(demos ${this.formatSize(result.demo_bytes)}, highlights ${this.formatSize(result.clip_bytes)}).`;
    await this.safeNotify("Orphaned uploads scan complete", message);
  }

  private async safeNotify(title: string, message: string): Promise<void> {
    try {
      await this.notifications.send("StorageScan" as e_notification_types_enum, {
        title,
        message,
        role: "administrator" as e_player_roles_enum,
      });
    } catch (error) {
      this.logger.warn(
        `[s3-scan] failed to send notification: ${(error as Error)?.message}`,
      );
    }
  }

  private async loadKnownKeys(): Promise<Set<string>> {
    const rows = await this.postgres.query<Array<{ key: string }>>(
      `SELECT file AS key FROM public.match_map_demos WHERE file IS NOT NULL
       UNION
       SELECT playback_file FROM public.match_map_demos WHERE playback_file IS NOT NULL
       UNION
       SELECT file FROM public.match_clips WHERE file IS NOT NULL
       UNION
       SELECT thumbnail_url FROM public.match_clips WHERE thumbnail_url IS NOT NULL`,
    );

    const keys = new Set<string>();
    for (const row of rows) {
      // External demos (faceit etc.) are stored as http(s) URLs, not S3 keys.
      if (row.key && !/^https?:\/\//i.test(row.key)) {
        keys.add(row.key);
      }
    }
    return keys;
  }

  private async persistResult(result: OrphanScanResult): Promise<void> {
    await this.s3.put(SCAN_RESULT_KEY, Buffer.from(JSON.stringify(result)));
  }

  public static sampleLimit(): number {
    return ORPHAN_SAMPLE_LIMIT;
  }

  private formatSize(bytes: number): string {
    const gigabytes = bytes / (1024 * 1024 * 1024);
    if (gigabytes >= 1) {
      return `${gigabytes.toFixed(2)} GB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}
