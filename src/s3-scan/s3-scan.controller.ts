import { Controller, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraAction } from "../hasura/hasura.controller";
import { S3ScanQueues } from "./enums/S3ScanQueues";
import { ScanOrphanedObjects } from "./jobs/ScanOrphanedObjects";
import { S3ScanService } from "./s3-scan.service";

@Controller("s3-scan")
export class S3ScanController {
  constructor(
    private readonly logger: Logger,
    private readonly s3Scan: S3ScanService,
    @InjectQueue(S3ScanQueues.Scan) private readonly scanQueue: Queue,
  ) {}

  // Kicks off the (potentially long-running) scan in the background and returns
  // immediately so the Hasura action doesn't time out. Results land in the logs
  // and are retrievable via orphanedDemosScanResult.
  @HasuraAction()
  public async scanOrphanedDemos() {
    if (this.s3Scan.isScanning()) {
      return { success: true, scanning: true };
    }
    await this.scanQueue.add(ScanOrphanedObjects.name, {});
    return { success: true, scanning: true };
  }

  @HasuraAction()
  public async orphanedDemosScanResult() {
    const result = await this.s3Scan.getResult();
    const scanning = this.s3Scan.isScanning();

    if (!result) {
      return {
        found: false,
        scanning,
        scanned_at: null,
        bucket: null,
        total_objects: 0,
        total_bytes: 0,
        tracked_objects: 0,
        tracked_bytes: 0,
        demo_objects: 0,
        demo_bytes: 0,
        clip_objects: 0,
        clip_bytes: 0,
        orphan_objects: 0,
        orphan_bytes: 0,
        other_objects: 0,
        other_bytes: 0,
        orphans: [],
      };
    }

    return {
      found: true,
      scanning,
      scanned_at: result.scanned_at,
      bucket: result.bucket,
      total_objects: result.total_objects,
      total_bytes: result.total_bytes,
      tracked_objects: result.tracked_objects,
      tracked_bytes: result.tracked_bytes,
      // Default the breakdown fields so reports persisted before they existed
      // still satisfy the (non-null) action schema — re-scan to populate them.
      demo_objects: result.demo_objects ?? 0,
      demo_bytes: result.demo_bytes ?? 0,
      clip_objects: result.clip_objects ?? 0,
      clip_bytes: result.clip_bytes ?? 0,
      orphan_objects: result.orphan_objects,
      orphan_bytes: result.orphan_bytes,
      other_objects: result.other_objects,
      other_bytes: result.other_bytes,
      // Cap the inline list — the full list lives in the persisted report and
      // delete operates on it directly.
      orphans: result.orphans.slice(0, S3ScanService.sampleLimit()),
    };
  }

  // Deletes orphans from the most recent scan. With no keys, deletes every
  // orphan the scan found; with keys, only that subset. Each key is re-verified
  // against the database before removal.
  @HasuraAction()
  public async deleteOrphanedDemos(data: { keys?: string[] }) {
    const { deleted, bytes_freed, remaining_orphans } =
      await this.s3Scan.deleteOrphans(data.keys);
    return { success: true, deleted, bytes_freed, remaining_orphans };
  }
}
