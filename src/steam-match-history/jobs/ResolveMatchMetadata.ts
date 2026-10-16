import { Job } from "bullmq";
import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamGcService, ResolvedMatch } from "../steam-gc.service";
import { MatchImportService } from "../match-import.service";
import { ParseImportedDemo } from "./ParseImportedDemo";

const STEAM64_INDIVIDUAL_OFFSET = 76561197960265728n;

export type ResolveMatchMetadataPayload = {
  valve_match_id: string;
};

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.ResolveMatchMetadata, {
  concurrency: 1,
  limiter: { max: 30, duration: 60_000 },
})
export class ResolveMatchMetadata extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly steamGc: SteamGcService,
    private readonly matchImport: MatchImportService,
    @InjectQueue(SteamMatchHistoryQueues.ParseImportedDemo)
    private readonly parseQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ResolveMatchMetadataPayload>): Promise<void> {
    try {
      await this.resolve(job.data.valve_match_id);
    } catch (error) {
      const lastAttempt =
        (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1) - 1;
      if (lastAttempt) {
        await this.markFailed(
          job.data.valve_match_id,
          (error as Error)?.message ?? String(error),
        );
      }
      throw error;
    }
  }

  private async resolve(valve_match_id: string): Promise<void> {
    const rows = await this.postgres.query<
      Array<{
        share_code: string;
        demo_url: string | null;
        match_start_time: string | null;
      }>
    >(
      `SELECT share_code, demo_url, match_start_time
         FROM public.pending_match_imports
        WHERE valve_match_id = $1::numeric`,
      [valve_match_id],
    );
    const row = rows.at(0);
    if (!row) {
      return;
    }

    // Already resolved (retry path) — straight to parse.
    if (row.demo_url) {
      await this.enqueueParse(valve_match_id, {
        share_code: row.share_code,
        demo_url: row.demo_url,
        match_start_time: row.match_start_time,
      });
      return;
    }

    if (!this.steamGc.isAvailable()) {
      await this.markFailed(valve_match_id, "steam gc not configured");
      return;
    }

    let resolved: ResolvedMatch | null;
    try {
      resolved = await this.steamGc.resolveShareCode(row.share_code);
    } catch (error) {
      // Connection-level failure (e.g. session replaced) — let BullMQ retry
      // with backoff instead of marking the match permanently failed.
      this.logger.warn(
        `steam-gc resolve failed for ${valve_match_id}, will retry: ${(error as Error).message}`,
      );
      throw error;
    }
    if (!resolved) {
      await this.markFailed(valve_match_id, "gc returned no match");
      return;
    }

    // Checked before the demo url is stored: a stored url skips the GC on a
    // retry, and with it this check.
    if (!(await this.requestedByAPlayer(valve_match_id, resolved.accountIds))) {
      await this.markFailed(
        valve_match_id,
        "only players in this match can import it",
      );
      return;
    }

    const demoUrl = resolved.demoUrl ?? row.demo_url;

    const matchStartTime =
      resolved.matchStartTime ??
      row.match_start_time ??
      (demoUrl ? await this.matchImport.resolveDemoStartTime(demoUrl) : null);

    this.logger.log(
      `resolved valve_match_id=${valve_match_id} map=${resolved.mapName ?? "<none>"} matchStartTime=${matchStartTime ?? "<none>"} [source=${resolved.matchStartTime ? "gc-matchtime" : matchStartTime ? "demo-cdn-last-modified" : "none"}] demoUrl=${demoUrl ?? "<none>"}`,
    );

    await this.postgres.query(
      `UPDATE public.pending_match_imports
         SET map_name = coalesce($2, map_name),
             match_start_time = $3,
             demo_url = $4
       WHERE valve_match_id = $1::numeric`,
      [valve_match_id, resolved.mapName, matchStartTime, demoUrl],
    );

    if (!demoUrl) {
      await this.markFailed(valve_match_id, "gc returned no demo url");
      return;
    }

    await this.enqueueParse(valve_match_id, {
      share_code: row.share_code,
      demo_url: demoUrl,
      match_start_time: matchStartTime,
    });
  }

  // Imports are for a player's own matches: someone who asked for this one has
  // to be in the GC's reservation, unless a match organizer or above asked. A
  // reservation that names nobody proves nothing, so only they get past it.
  private async requestedByAPlayer(
    valveMatchId: string,
    accountIds: Array<number>,
  ): Promise<boolean> {
    const players = accountIds.map((id) =>
      (STEAM64_INDIVIDUAL_OFFSET + BigInt(id)).toString(),
    );
    const [row] = await this.postgres.query<Array<{ allowed: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM public.pending_match_import_players requester
           JOIN public.players player ON player.steam_id = requester.steam_id
          WHERE requester.valve_match_id = $1::numeric
            AND (requester.steam_id = ANY($2::bigint[])
                 OR public.is_role_below('match_organizer', player.role))
       ) AS allowed`,
      [valveMatchId, players],
    );
    return row?.allowed === true;
  }

  private async enqueueParse(
    valveMatchId: string,
    extra: {
      share_code: string;
      demo_url: string | null;
      match_start_time: string | null;
    },
  ): Promise<void> {
    const jobId = `parse-${valveMatchId}`;
    await this.parseQueue.remove(jobId).catch(() => {});
    await this.parseQueue.add(
      ParseImportedDemo.name,
      { valve_match_id: valveMatchId, ...extra },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 15_000 },
      },
    );
  }

  private async markFailed(
    valveMatchId: string,
    reason: string,
  ): Promise<void> {
    // No match exists yet at the resolve stage (it's created later during
    // parse/import), so there is nothing to clean up here beyond the status.
    await this.postgres.query(
      `UPDATE public.pending_match_imports
         SET status = 'Failed', error = $2
       WHERE valve_match_id = $1::numeric`,
      [valveMatchId, reason],
    );
    this.logger.warn(
      `resolve-match-metadata failed valve_match_id=${valveMatchId}: ${reason}`,
    );
  }
}
