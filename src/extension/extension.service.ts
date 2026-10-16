import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { CacheService } from "../cache/cache.service";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { PostgresService } from "../postgres/postgres.service";
import { FaceitService } from "../faceit/faceit.service";
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
  stage?: ImportLookup["stage"];
  progress?: number;
};

export type FaceitRoom = { id: string; maps?: number };

@Injectable()
export class ExtensionService {
  public static readonly HOURLY_IMPORT_LIMIT = 30;
  public static readonly HOURLY_FACEIT_LOOKUP_LIMIT = 120;
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

  // A series with only some maps in 5Stack reads as "none", so the extension
  // still offers it; the maps already imported come back "imported" again
  // without being fetched.
  private static readonly STATE_PRIORITY: Array<ImportLookup["state"]> = [
    "failed",
    "importing",
    "queued",
    "none",
    "imported",
  ];

  constructor(
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly steamMatchHistory: SteamMatchHistoryService,
    private readonly faceit: FaceitService,
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

  // FACEIT's poller has its own switch because it needs the Downloads API;
  // the extension does not, so only the match imports switch and the Data
  // API key that checks its links apply.
  public async imports(): Promise<{ faceit: boolean; valve: boolean }> {
    const [allowed, valve] = await Promise.all([
      this.steamMatchHistory.isImportingAllowed(),
      this.steamMatchHistory.canImportShareCodes(),
    ]);
    return { faceit: allowed && this.faceit.isEnabled(), valve };
  }

  public async faceitAccount(
    steamId: string,
  ): Promise<{ player_id: string; nickname: string | null } | null> {
    const [player] = await this.postgres.query<
      Array<{ faceit_player_id: string | null; faceit_nickname: string | null }>
    >(
      `SELECT faceit_player_id, faceit_nickname FROM public.players
        WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return player?.faceit_player_id
      ? { player_id: player.faceit_player_id, nickname: player.faceit_nickname }
      : null;
  }

  public async lookupFaceit(
    rooms: Array<FaceitRoom>,
  ): Promise<Record<string, FaceitLookup>> {
    const externalIds = new Map<string, Array<string>>();
    for (const room of rooms) {
      const requested = Math.trunc(Number(room.maps ?? 1));
      const maps = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 1), ExtensionService.MAX_MAPS)
        : 1;
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
      const busy = maps.find((map) => map.state === "importing");
      result[roomId] = {
        state,
        match_ids: maps.map((map) => map.match_id).filter(Boolean),
        ...(state === "failed"
          ? { reason: maps.find((map) => map.state === "failed").reason }
          : {}),
        ...(state === "importing" && busy?.stage
          ? { stage: busy.stage, progress: busy.progress }
          : {}),
      };
    }
    return result;
  }

  public static canImportAnyone(user: Pick<User, "role">): boolean {
    return isRoleAbove(user.role, "match_organizer");
  }

  public async queueFaceitDemo(
    user: Pick<User, "steam_id" | "role">,
    demo: { matchId: string; url: string },
  ): Promise<ImportLookup> {
    const steamId = user.steam_id;
    const match = await this.faceitDemos(steamId, demo.matchId);
    if (!match) {
      throw new ServiceUnavailableException(
        "FACEIT did not answer, try again shortly",
      );
    }
    // Imports are for a player's own matches; match organizers and above may
    // import any.
    if (
      !ExtensionService.canImportAnyone(user) &&
      !match.players.includes(steamId)
    ) {
      throw new ForbiddenException("only players in this match can import it");
    }
    const index = match.demoUrls.findIndex((resourceUrl) => {
      try {
        ExtensionService.assertSignedLinkFor(demo.url, resourceUrl);
        return true;
      } catch {
        return false;
      }
    });
    if (index === -1) {
      throw new BadRequestException("not one of this match's FACEIT demos");
    }
    const url = ExtensionService.assertSignedLinkFor(
      demo.url,
      match.demoUrls[index],
    );
    const externalId = ExtensionService.externalIdFor(demo.matchId, index + 1);

    const [existing] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM public.matches
        WHERE source = 'faceit' AND external_id = $1
        LIMIT 1`,
      [externalId],
    );
    if (existing) {
      return { state: "imported", match_id: existing.id };
    }

    const current = await this.jobLookup(externalId);
    if (
      current?.state === "queued" ||
      current?.state === "importing" ||
      current?.state === "imported"
    ) {
      return current;
    }

    await this.consume(
      `extension:imports:${steamId}`,
      1,
      ExtensionService.HOURLY_IMPORT_LIMIT,
      `import limit reached: ${ExtensionService.HOURLY_IMPORT_LIMIT} demos an hour`,
    );

    // A failed or finished attempt keeps its job id, and the queue would
    // ignore a new job under it. A fetch another request has just picked up
    // is locked and stays; the parse job has to go, or the new fetch's parse
    // would be swallowed by it.
    const [fetchJob, parseJob] = await this.jobs(externalId);
    await parseJob?.remove();
    await fetchJob?.remove().catch((): undefined => undefined);

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

  // Each call spends the operator's FACEIT API quota, so it is metered per
  // player before it is made, and a series' maps share one answer.
  private async faceitDemos(
    steamId: string,
    matchId: string,
  ): Promise<{
    demoUrls: Array<string>;
    finishedAt: string | null;
    players: Array<string>;
  } | null> {
    const key = `extension:faceit-demos:v2:${matchId}`;
    const cached = await this.cache.get(key);
    if (cached) {
      return cached;
    }
    await this.consume(
      `extension:faceit-lookups:${steamId}`,
      1,
      ExtensionService.HOURLY_FACEIT_LOOKUP_LIMIT,
      "too many FACEIT lookups, try again later",
    );
    const match = await this.faceit.getMatchDemos(matchId);
    if (match && match.demoUrls.length > 0) {
      await this.cache.put(key, match, 5 * 60);
    }
    return match;
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
      await this.consume(
        `extension:imports:${steamId}`,
        toImport.length,
        ExtensionService.HOURLY_IMPORT_LIMIT,
        `import limit reached: ${ExtensionService.HOURLY_IMPORT_LIMIT} demos an hour`,
      );
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

  private async consume(
    key: string,
    amount: number,
    limit: number,
    message: string,
  ) {
    if (!(await this.cache.consume(key, amount, limit, 60 * 60 * 1000))) {
      throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
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
    if (parseJob) {
      const state = await parseJob.getState();
      if (state === "completed") {
        const matchId = (parseJob.data as { match_id?: string }).match_id;
        return matchId ? { state: "imported", match_id: matchId } : null;
      }
      const lookup = ExtensionService.pendingLookup(
        state,
        parseJob.failedReason,
      );
      return lookup.state === "importing"
        ? { ...lookup, stage: "processing" }
        : lookup;
    }
    if (fetchJob) {
      const state = await fetchJob.getState();
      if (state === "completed") {
        return null;
      }
      const lookup = ExtensionService.pendingLookup(
        state,
        fetchJob.failedReason,
      );
      return lookup.state === "importing"
        ? {
            ...lookup,
            stage: "downloading",
            progress:
              typeof fetchJob.progress === "number" ? fetchJob.progress : 0,
          }
        : lookup;
    }
    return null;
  }

  private static pendingLookup(state: string, reason?: string): ImportLookup {
    if (state === "failed") {
      return { state: "failed", reason };
    }
    if (state === "active") {
      return { state: "importing" };
    }
    return { state: "queued" };
  }
}
