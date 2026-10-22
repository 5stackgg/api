import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { CacheService } from "../cache/cache.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "../../generated";
import {
  PlayerEloRecomputeService,
  RebuildLease,
} from "./player-elo-recompute.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { TypesenseQueues } from "../type-sense/enums/TypesenseQueues";
import { RefreshAllPlayersJob } from "../type-sense/jobs/RefreshAllPlayers";

// Redis-backed so any replica can read progress / request cancellation. Backfill
// runs on a concurrency-1 queue, so a single global status blob is sufficient.
const STATUS_KEY = "season-elo-backfill:status";
const CANCEL_KEY = "season-elo-backfill:cancel";

const RUNNING_TTL_SECONDS = 300;
const FINAL_TTL_SECONDS = 7 * 24 * 3600;
const CANCEL_TTL_SECONDS = 600;

export type SeasonEloBackfillStatus = {
  running: boolean;
  canceled: boolean;
  started_at: string | null;
  finished_at: string | null;
  season_id: string | null;
  total: number;
  completed: number;
  failed: number;
  current_match_id: string | null;
};

@Injectable()
export class SeasonEloBackfillService {
  public static readonly RETRY_DELAY_MS = 15_000;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
    private readonly eloRecompute: PlayerEloRecomputeService,
    @InjectQueue(TypesenseQueues.PlayerReindex)
    private readonly reindexQueue: Queue,
  ) {}

  public async isRunning(): Promise<boolean> {
    return (await this.getStatus()).running;
  }

  public async requestCancel(): Promise<void> {
    if ((await this.getStatus()).running) {
      await this.cache.put(CANCEL_KEY, true, CANCEL_TTL_SECONDS);
    }
  }

  public async getStatus(): Promise<SeasonEloBackfillStatus> {
    return (await this.cache.get(STATUS_KEY)) ?? this.idleStatus();
  }

  private idleStatus(): SeasonEloBackfillStatus {
    return {
      running: false,
      canceled: false,
      started_at: null,
      finished_at: null,
      season_id: null,
      total: 0,
      completed: 0,
      failed: 0,
      current_match_id: null,
    };
  }

  public async markQueued(seasonId: string): Promise<void> {
    await this.cache.forget(CANCEL_KEY);
    await this.saveStatus(
      {
        ...this.idleStatus(),
        running: true,
        season_id: seasonId,
        started_at: new Date().toISOString(),
      },
      RUNNING_TTL_SECONDS,
    );
  }

  // False means run it again later: another rebuild holds the lock or took it
  // over, or the season's dates moved mid-run so the matches it rebuilt are no
  // longer its own.
  public async runBackfill(seasonId: string): Promise<boolean> {
    const window = await this.fetchSeasonWindow(seasonId);
    if (!window) {
      this.logger.warn(`[season-backfill] season ${seasonId} no longer exists`);
      const queued = await this.getStatus();
      if (queued.running && queued.season_id === seasonId) {
        await this.saveStatus(
          {
            ...queued,
            running: false,
            finished_at: new Date().toISOString(),
          },
          FINAL_TTL_SECONDS,
        );
      }
      return true;
    }

    // The full recompute's lock: either rebuild deleting player_elo under the
    // other would corrupt both chronological rebuilds.
    const lease = await this.eloRecompute.acquireRebuildLease();
    if (!lease) {
      this.logger.warn(
        `[season-backfill] another rebuild holds the lock, retrying season ${seasonId}`,
      );
      return false;
    }

    try {
      return await this.rebuildSeason(seasonId, window, lease);
    } finally {
      await lease.release();
    }
  }

  private async rebuildSeason(
    seasonId: string,
    window: { starts_at: string; ends_at: string | null },
    lease: RebuildLease,
  ): Promise<boolean> {
    await this.cache.forget(CANCEL_KEY);

    const status: SeasonEloBackfillStatus = {
      ...this.idleStatus(),
      running: true,
      season_id: seasonId,
      started_at: new Date().toISOString(),
    };
    await this.saveStatus(status, RUNNING_TTL_SECONDS);
    await this.eloRecompute.setSuppressEvents(true);

    let held = true;
    let current = true;
    try {
      // Clean slate for this season only — other seasons' ELO is independent and
      // stays untouched. Per-match recompute below re-inserts with season_id set.
      await this.postgres.query(
        `DELETE FROM player_elo WHERE season_id = $1`,
        [seasonId],
      );

      held = await this.eloRecompute.rateMatches(
        lease,
        status,
        () => this.fetchSeasonMatchIds(seasonId),
        {
          label: "season-backfill",
          isCanceled: () => this.isCancelRequested(),
          persist: async () => {
            await this.saveStatus(status, RUNNING_TTL_SECONDS);
            await this.eloRecompute.setSuppressEvents(true);
          },
        },
      );

      // Authoritative rebuild of the season's aggregate stats from source rows.
      if (held && !status.canceled) {
        await this.postgres.query(`SELECT rebuild_player_season_stats($1)`, [
          seasonId,
        ]);
        // Only clear the flag for the window that was rebuilt; a date edit made
        // mid-run re-flagged it, and its event deduped onto this still-active job.
        const cleared = await this.postgres.query<Array<{ id: string }>>(
          `
          UPDATE seasons SET needs_rebuild = false
          WHERE id = $1
            AND starts_at = $2::timestamptz
            AND ends_at IS NOT DISTINCT FROM $3::timestamptz
          RETURNING id
          `,
          [seasonId, window.starts_at, window.ends_at],
        );
        current = cleared.length > 0;
      }
    } finally {
      // A lost lock leaves the status, suppression and reindex to whichever
      // rebuild holds it now; this run is retried.
      if (held) {
        status.running = false;
        status.current_match_id = null;
        status.finished_at = new Date().toISOString();
        await this.saveStatus(status, FINAL_TTL_SECONDS);
        await this.cache.forget(CANCEL_KEY);
        // Per-row player_elo search events stay suppressed for the whole run, so
        // the search index would otherwise keep serving pre-backfill ELO forever.
        // One deduped reindex at the end syncs it without the per-row fan-out.
        await this.eloRecompute.setSuppressEvents(false);

        await this.reindexQueue.add(
          RefreshAllPlayersJob.name,
          {},
          {
            jobId: RefreshAllPlayersJob.name,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );

        this.logger.log(
          `[season-backfill] finished season ${seasonId}: ${status.completed}/${status.total} processed, ${status.failed} failed${status.canceled ? " (canceled)" : ""}`,
        );

        await this.notifyComplete(status);
      }
    }

    return held && current;
  }

  private async notifyComplete(status: SeasonEloBackfillStatus): Promise<void> {
    if (!status.canceled && status.failed === 0) {
      return;
    }

    const duration = this.formatDuration(status.started_at, status.finished_at);
    const failedSuffix =
      status.failed > 0 ? ` <b>${status.failed}</b> failed.` : "";

    const seasonLabel = await this.seasonLabel(status.season_id);
    const title = status.canceled
      ? `${seasonLabel} backfill canceled`
      : `${seasonLabel} backfill complete`;
    const verb = status.canceled ? "Canceled after rebuilding" : "Rebuilt";
    const message =
      `${verb} <b>${seasonLabel}</b> ELO for <b>${status.completed}</b> of <b>${status.total}</b> matches ` +
      `in <b>${duration}</b>.${failedSuffix}`;

    try {
      await this.notifications.send(
        "EloRecompute" as e_notification_types_enum,
        {
          title,
          message,
          role: "administrator" as e_player_roles_enum,
        },
      );
    } catch (error) {
      this.logger.warn(
        `[season-backfill] failed to send notification: ${(error as Error)?.message}`,
      );
    }
  }

  // Human label for a season used in notifications, e.g. "Season 3" or
  // "Season 3 (Playoffs)".
  private async seasonLabel(seasonId: string | null): Promise<string> {
    if (!seasonId) {
      return "Season";
    }
    try {
      const rows = await this.postgres.query<
        Array<{ number: number | null; description: string | null }>
      >(`SELECT number, description FROM seasons WHERE id = $1`, [seasonId]);
      const row = rows?.[0];
      if (!row) {
        return "Season";
      }
      const base = `Season ${row.number ?? "?"}`;
      return row.description ? `${base} (${row.description})` : base;
    } catch {
      return "Season";
    }
  }

  private formatDuration(
    startedAt: string | null,
    finishedAt: string | null,
  ): string {
    if (!startedAt || !finishedAt) {
      return "unknown";
    }
    const totalSeconds = Math.max(
      0,
      Math.round(
        (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000,
      ),
    );
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  private async isCancelRequested(): Promise<boolean> {
    return (await this.cache.get(CANCEL_KEY)) === true;
  }

  private async saveStatus(
    status: SeasonEloBackfillStatus,
    ttl: number,
  ): Promise<void> {
    await this.cache.put(STATUS_KEY, status, ttl);
  }

  // Text round-trip keeps microseconds, so the values compare exactly when
  // passed back to Postgres.
  private async fetchSeasonWindow(
    seasonId: string,
  ): Promise<{ starts_at: string; ends_at: string | null } | null> {
    const rows = await this.postgres.query<
      Array<{ starts_at: string; ends_at: string | null }>
    >(
      `SELECT starts_at::text AS starts_at, ends_at::text AS ends_at FROM seasons WHERE id = $1`,
      [seasonId],
    );
    return rows?.[0] ?? null;
  }

  private async fetchSeasonMatchIds(seasonId: string): Promise<string[]> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `
      SELECT m.id::text AS id
      FROM matches m
      WHERE m.ended_at IS NOT NULL
        AND m.winning_lineup_id IS NOT NULL
        AND m.source = '5stack'
        AND season_for_timestamp(m.ended_at) = $1
        AND NOT EXISTS (
          SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id
        )
      ORDER BY m.ended_at ASC, m.created_at ASC, m.id ASC
      `,
      [seasonId],
    );
    return rows.map((row) => row.id);
  }
}
