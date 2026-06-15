import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { DemoParserService } from "../demos/demo-parser.service";
import { MatchImportService } from "../steam-match-history/match-import.service";
import { FaceitService } from "./faceit.service";
import { FaceitQueues } from "./enums/FaceitQueues";

@Injectable()
export class FaceitMatchImportService {
  private static readonly POLL_LIMIT = 100;
  private static readonly POLL_CONCURRENCY = 2;
  private static readonly POLL_WINDOW_DAYS = 30;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly faceit: FaceitService,
    private readonly demoParser: DemoParserService,
    private readonly matchImport: MatchImportService,
    @InjectQueue(FaceitQueues.ImportFaceitMatch)
    private readonly importQueue: Queue,
  ) {}

  public async isImportingAllowed(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = 'public.external_matches_enabled' LIMIT 1`,
    );
    return rows.at(0)?.value === "true";
  }

  public async isFaceitImportEnabled(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = 'public.faceit_import_enabled' LIMIT 1`,
    );
    return rows.at(0)?.value === "true";
  }

  public async enqueueMatch(matchId: string): Promise<void> {
    const jobId = `faceit-import-${matchId}`;
    await this.importQueue.remove(jobId).catch(() => {});
    await this.importQueue.add(
      FaceitQueues.ImportFaceitMatch,
      { faceit_match_id: matchId },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 15_000 },
      },
    );
  }

  public async importMatch(
    matchId: string,
  ): Promise<{ matchId: string | null; skipped?: string }> {
    if (!(await this.isFaceitImportEnabled())) {
      return { matchId: null, skipped: "faceit import disabled" };
    }

    const existing = await this.matchImport.findExistingExternalMatch(
      "faceit",
      matchId,
    );
    if (existing) {
      return { matchId: existing, skipped: "already imported" };
    }

    const { demoUrl: resourceUrl, startedAt } =
      await this.faceit.getMatchDemo(matchId);
    if (!resourceUrl) {
      return { matchId: null, skipped: "no demo url from faceit" };
    }

    const fetchUrl = await this.faceit.signDownloadUrl(resourceUrl);
    if (!fetchUrl) {
      throw new Error(
        "faceit demo download not authorized — your FACEIT key needs Downloads API access. Apply at https://fce.gg/downloads-api-application (see https://docs.5stack.gg/advanced/faceit-integration).",
      );
    }

    const parsed = await this.demoParser.parseFromUrl(fetchUrl);
    if (!parsed) {
      throw new Error("demo parse failed");
    }

    return this.matchImport.importExternalDemo(
      parsed,
      "faceit",
      matchId,
      resourceUrl,
      startedAt,
      matchId,
    );
  }

  public async pollForPlayer(steamId: string): Promise<number> {
    const playerId = await this.faceit.resolvePlayerId(steamId);
    if (!playerId) {
      return 0;
    }

    const windowStart = Math.floor(
      (Date.now() -
        FaceitMatchImportService.POLL_WINDOW_DAYS * 24 * 60 * 60 * 1000) /
        1000,
    );
    const cursor = await this.loadSyncCursor(steamId);
    const sinceSeconds = Math.max(windowStart, cursor);

    const matches = await this.faceit.getRecentMatches(playerId, {
      sinceSeconds,
      limit: FaceitMatchImportService.POLL_LIMIT,
    });

    let queued = 0;
    let newest = cursor;
    for (const match of matches) {
      if (match.finishedAt != null && match.finishedAt <= cursor) {
        continue;
      }
      if (match.finishedAt != null && match.finishedAt > newest) {
        newest = match.finishedAt;
      }
      const existing = await this.matchImport.findExistingExternalMatch(
        "faceit",
        match.matchId,
      );
      if (existing) {
        continue;
      }
      await this.enqueueMatch(match.matchId);
      queued++;
    }

    if (newest > cursor) {
      await this.saveSyncCursor(steamId, newest);
    }

    this.logger.log(
      `faceit poll steam_id=${steamId} player_id=${playerId} matches=${matches.length} queued=${queued} cursor=${newest}`,
    );
    return queued;
  }

  private async loadSyncCursor(steamId: string): Promise<number> {
    const rows = await this.postgres.query<Array<{ synced_at: string | null }>>(
      `SELECT EXTRACT(EPOCH FROM faceit_synced_at)::bigint::text AS synced_at
         FROM public.players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    const value = rows.at(0)?.synced_at;
    return value ? Number(value) : 0;
  }

  private async saveSyncCursor(
    steamId: string,
    finishedAtSeconds: number,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.players
          SET faceit_synced_at = to_timestamp($2)
        WHERE steam_id = $1::bigint`,
      [steamId, finishedAtSeconds],
    );
  }

  public async pollAllActive(): Promise<void> {
    if (!this.faceit.isEnabled()) {
      this.logger.warn(
        "faceit pollAllActive skipped: FACEIT_API_KEY not configured",
      );
      return;
    }
    if (!(await this.isImportingAllowed())) {
      this.logger.log(
        "faceit pollAllActive skipped: external match imports disabled",
      );
      return;
    }
    if (!(await this.isFaceitImportEnabled())) {
      this.logger.log("faceit pollAllActive skipped: faceit import disabled");
      return;
    }

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { player_steam_match_auth } = await this.hasura.query({
      player_steam_match_auth: {
        __args: {
          where: {
            player: {
              last_sign_in_at: { _gte: cutoff.toISOString() },
            },
          },
        },
        steam_id: true,
      },
    });

    this.logger.log(
      `faceit pollAllActive selected ${player_steam_match_auth.length} opted-in active users (signed in since ${cutoff.toISOString()})`,
    );

    const queue = player_steam_match_auth.map((row) => String(row.steam_id));
    const workers = Array.from(
      { length: FaceitMatchImportService.POLL_CONCURRENCY },
      async () => {
        while (queue.length > 0) {
          const steamId = queue.shift();
          if (!steamId) {
            return;
          }
          try {
            await this.pollForPlayer(steamId);
          } catch (error) {
            this.logger.error(
              `faceit pollForPlayer failed for ${steamId}`,
              error,
            );
          }
        }
      },
    );
    await Promise.all(workers);
  }
}
