import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import { FaceitService } from "../faceit/faceit.service";
import { FaceitMatchImportService } from "../faceit/faceit-match-import.service";
import {
  ImportLookup,
  SteamMatchHistoryService,
} from "../steam-match-history/steam-match-history.service";
import { SteamMatchHistoryQueues } from "../steam-match-history/enums/SteamMatchHistoryQueues";
import { ExtensionQueues } from "./enums/ExtensionQueues";
import {
  FetchFaceitDemo,
  FetchFaceitDemoPayload,
} from "./jobs/FetchFaceitDemo";

export type FaceitLookup = {
  state: ImportLookup["state"];
  match_ids: Array<string>;
  reason?: string;
};

export type FaceitRoom = { id: string; maps?: number };

@Injectable()
export class ExtensionService {
  public static readonly HOURLY_IMPORT_LIMIT = 30;
  public static readonly MAX_MAPS = 5;

  private static readonly FACEIT_MATCH_ID =
    /^1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // FACEIT names a demo by a resource url on its own domain,
  // demos-<region>.backblaze.faceit-cdn.net, stored in the B2 bucket
  // demos-<region>-faceit-cdn. Bucket names are first come first served, so
  // the bucket is derived from FACEIT's answer, never matched by pattern.
  private static readonly FACEIT_RESOURCE_HOST =
    /^(demos-[a-z0-9-]+)\.backblaze\.faceit-cdn\.net$/;

  private static readonly B2_BUCKET_HOST =
    /^([a-z0-9-]+)\.s3\.[a-z0-9-]+\.backblazeb2\.com$/;

  private static readonly STATE_PRIORITY: Array<ImportLookup["state"]> = [
    "failed",
    "importing",
    "queued",
    "imported",
    "none",
  ];

  constructor(
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly steamMatchHistory: SteamMatchHistoryService,
    private readonly faceit: FaceitService,
    private readonly faceitImport: FaceitMatchImportService,
    @InjectQueue(ExtensionQueues.FetchFaceitDemo)
    private readonly fetchQueue: Queue,
    @InjectQueue(SteamMatchHistoryQueues.ProcessUploadedDemo)
    private readonly parseQueue: Queue,
  ) {}

  public static isFaceitMatchId(id: unknown): id is string {
    return typeof id === "string" && ExtensionService.FACEIT_MATCH_ID.test(id);
  }

  public static externalIdFor(matchId: string, map: number): string {
    return map === 1 ? matchId : `${matchId}.${map}`;
  }

  public static assertSignedLinkFor(
    input: string,
    resourceUrl: string,
  ): string {
    let url: URL;
    let resource: URL;
    try {
      url = new URL(input);
      resource = new URL(resourceUrl);
    } catch {
      throw new BadRequestException("invalid demo url");
    }
    const bucket = resource.hostname
      .toLowerCase()
      .match(ExtensionService.FACEIT_RESOURCE_HOST)?.[1];
    const signedBucket = url.hostname
      .toLowerCase()
      .match(ExtensionService.B2_BUCKET_HOST)?.[1];
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !bucket ||
      signedBucket !== `${bucket}-faceit-cdn`
    ) {
      throw new BadRequestException("not a FACEIT demo url");
    }
    if (url.pathname !== resource.pathname) {
      throw new BadRequestException("demo url is for a different demo");
    }
    return url.toString();
  }

  public async imports(): Promise<{ faceit: boolean; valve: boolean }> {
    const [allowed, faceit, valve] = await Promise.all([
      this.steamMatchHistory.isImportingAllowed(),
      this.faceitImport.isFaceitImportEnabled(),
      this.steamMatchHistory.canImportShareCodes(),
    ]);
    return { faceit: allowed && faceit && this.faceit.isEnabled(), valve };
  }

  public async lookupFaceit(
    rooms: Array<FaceitRoom>,
  ): Promise<Record<string, FaceitLookup>> {
    const externalIds = new Map<string, Array<string>>();
    for (const room of rooms) {
      const maps = Math.min(
        Math.max(Math.trunc(room.maps ?? 1), 1),
        ExtensionService.MAX_MAPS,
      );
      externalIds.set(
        room.id,
        Array.from({ length: maps }, (_, i) =>
          ExtensionService.externalIdFor(room.id, i + 1),
        ),
      );
    }

    const imported = new Map(
      (
        await this.postgres.query<Array<{ id: string; external_id: string }>>(
          `SELECT id, external_id FROM public.matches
            WHERE source = 'faceit' AND external_id = ANY($1::text[])`,
          [[...externalIds.values()].flat()],
        )
      ).map((row) => [row.external_id, row.id]),
    );

    const result: Record<string, FaceitLookup> = {};
    for (const [roomId, ids] of externalIds) {
      const maps = await Promise.all(
        ids.map(async (externalId): Promise<ImportLookup> => {
          const matchId = imported.get(externalId);
          if (matchId) {
            return { state: "imported", match_id: matchId };
          }
          return (await this.jobLookup(externalId)) ?? { state: "none" };
        }),
      );
      const state = ExtensionService.STATE_PRIORITY.find((candidate) =>
        maps.some((map) => map.state === candidate),
      );
      result[roomId] = {
        state,
        match_ids: maps.map((map) => map.match_id).filter(Boolean),
        ...(state === "failed"
          ? { reason: maps.find((map) => map.state === "failed").reason }
          : {}),
      };
    }
    return result;
  }

  public async queueFaceitDemo(
    steamId: string,
    demo: { matchId: string; map: number; url: string },
  ): Promise<ImportLookup> {
    const externalId = ExtensionService.externalIdFor(demo.matchId, demo.map);

    const [existing] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM public.matches
        WHERE source = 'faceit' AND external_id = $1
        LIMIT 1`,
      [externalId],
    );
    if (existing) {
      return { state: "imported", match_id: existing.id };
    }

    const match = await this.faceit.getMatchDemos(demo.matchId);
    const resourceUrl = match?.demoUrls[demo.map - 1];
    if (!resourceUrl) {
      throw new BadRequestException("FACEIT has no demo for this map");
    }
    const url = ExtensionService.assertSignedLinkFor(demo.url, resourceUrl);

    const current = await this.jobLookup(externalId);
    if (current?.state === "queued" || current?.state === "importing") {
      return current;
    }

    await this.consumeImports(steamId, 1);

    // A failed or finished attempt keeps its job id, and the queue would
    // ignore a new job under it.
    const [fetchJob, parseJob] = await this.jobs(externalId);
    await Promise.all([fetchJob?.remove(), parseJob?.remove()]);

    await this.fetchQueue.add(
      FetchFaceitDemo.name,
      {
        url,
        external_id: externalId,
        steam_id: steamId,
        match_start_time: match.finishedAt,
      } satisfies FetchFaceitDemoPayload,
      {
        jobId: ExtensionService.fetchJobId(externalId),
        attempts: 2,
        backoff: { type: "fixed", delay: 5_000 },
      },
    );

    return { state: "queued" };
  }

  public async lookupValve(
    shareCodes: Array<string>,
  ): Promise<Record<string, ImportLookup>> {
    return this.steamMatchHistory.lookupShareCodes(shareCodes);
  }

  public async queueShareCodes(
    steamId: string,
    shareCodes: Array<string>,
  ): Promise<Record<string, ImportLookup>> {
    const before = await this.steamMatchHistory.lookupShareCodes(shareCodes);
    const toImport = shareCodes.filter(
      (code) =>
        !before[code].reason &&
        (before[code].state === "none" || before[code].state === "failed"),
    );
    if (toImport.length > 0) {
      await this.consumeImports(steamId, toImport.length);
    }

    const errors = new Map<string, string>();
    for (const code of toImport) {
      const result = await this.steamMatchHistory.importShareCode(
        steamId,
        code,
        { cooldown: false },
      );
      if (!result.ok) {
        errors.set(code, result.error);
      }
    }

    const after = await this.steamMatchHistory.lookupShareCodes(shareCodes);
    for (const [code, reason] of errors) {
      if (after[code].state === "none") {
        after[code] = { state: "failed", reason };
      }
    }
    return after;
  }

  private async consumeImports(steamId: string, amount: number) {
    const allowed = await this.cache.consume(
      `extension:imports:${steamId}`,
      amount,
      ExtensionService.HOURLY_IMPORT_LIMIT,
      60 * 60 * 1000,
    );
    if (!allowed) {
      throw new HttpException(
        `import limit reached: ${ExtensionService.HOURLY_IMPORT_LIMIT} demos an hour`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private static fetchJobId(externalId: string): string {
    return `ext.faceit.${externalId}`;
  }

  private async jobs(
    externalId: string,
  ): Promise<[Job | undefined, Job | undefined]> {
    const fetchJobId = ExtensionService.fetchJobId(externalId);
    return Promise.all([
      this.fetchQueue.getJob(fetchJobId),
      this.parseQueue.getJob(`${fetchJobId}.parse`),
    ]);
  }

  private async jobLookup(externalId: string): Promise<ImportLookup | null> {
    const [fetchJob, parseJob] = await this.jobs(externalId);
    const job = parseJob ?? fetchJob;
    if (!job) {
      return null;
    }
    const state = await job.getState();
    if (state === "failed") {
      return { state: "failed", reason: job.failedReason };
    }
    if (state === "active") {
      return { state: "importing" };
    }
    if (state === "completed" && job === parseJob) {
      return null;
    }
    return { state: "queued" };
  }
}
