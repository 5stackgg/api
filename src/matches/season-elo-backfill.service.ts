import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { CacheService } from "../cache/cache.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "../../generated";
import { PlayerEloRecomputeService } from "./player-elo-recompute.service";

// Redis-backed so any replica can read progress / request cancellation. Backfill
// runs on a concurrency-1 queue, so a single global status blob is sufficient.
const STATUS_KEY = "season-elo-backfill:status";
const CANCEL_KEY = "season-elo-backfill:cancel";
const LOCK_KEY = "season-elo-backfill:lock";

const PERSIST_EVERY = 25;
const ITEM_TIMEOUT_MS = 60_000;
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
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
    private readonly eloRecompute: PlayerEloRecomputeService,
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

  public async runBackfill(seasonId: string): Promise<void> {
    // Single-execution guarantee mirrors the recompute: the lock holder is the
    // only writer, so overlapping runs can't corrupt the chronological rebuild.
    if (!(await this.cache.acquireLock(LOCK_KEY, RUNNING_TTL_SECONDS))) {
      this.logger.warn(
        "[season-backfill] already running, skipping duplicate",
      );
      return;
    }

    await this.cache.forget(CANCEL_KEY);

    const status: SeasonEloBackfillStatus = {
      ...this.idleStatus(),
      running: true,
      season_id: seasonId,
      started_at: new Date().toISOString(),
    };
    await this.saveStatus(status, RUNNING_TTL_SECONDS);
    await this.eloRecompute.setSuppressEvents(true);

    try {
      // Fast path: the very first season that covers all history. The existing
      // global ELO ladder already IS this season's ladder (same matches, same
      // 5000 baseline, same chronological order), so adopt it by re-tagging the
      // rows instead of recomputing every match. Values are unchanged, so there's
      // nothing to reindex either.
      const adopted = await this.tryAdoptGlobalLadder(seasonId);
      if (adopted !== null) {
        status.total = adopted;
        status.completed = adopted;
        await this.postgres.query(
          `UPDATE seasons SET needs_rebuild = false WHERE id = $1`,
          [seasonId],
        );
        await this.saveStatus(status, RUNNING_TTL_SECONDS);
        return;
      }

      // Clean slate for this season only — other seasons' ELO is independent and
      // stays untouched. Per-match recompute below re-inserts with season_id set.
      await this.postgres.query(
        `DELETE FROM player_elo WHERE season_id = $1`,
        [seasonId],
      );

      const ids = await this.fetchSeasonMatchIds(seasonId);
      status.total = ids.length;
      await this.saveStatus(status, RUNNING_TTL_SECONDS);

      this.logger.log(
        `[season-backfill] rebuilding ELO for season ${seasonId} across ${ids.length} matches`,
      );

      for (const id of ids) {
        if (await this.isCancelRequested()) {
          status.canceled = true;
          this.logger.warn("[season-backfill] canceled by request");
          break;
        }
        status.current_match_id = id;
        try {
          await this.withTimeout(
            this.postgres.query(`SELECT generate_player_elo_for_match($1)`, [
              id,
            ]),
            ITEM_TIMEOUT_MS,
          );
        } catch (error) {
          status.failed += 1;
          this.logger.warn(
            `[season-backfill] match ${id} failed: ${(error as Error)?.message}`,
          );
        }
        status.completed += 1;
        if (status.completed % PERSIST_EVERY === 0) {
          await this.saveStatus(status, RUNNING_TTL_SECONDS);
          await this.eloRecompute.setSuppressEvents(true);
          await this.cache.refreshLock(LOCK_KEY, RUNNING_TTL_SECONDS);
        }
      }

      // Authoritative rebuild of the season's aggregate stats from source rows.
      if (!status.canceled) {
        await this.postgres.query(`SELECT rebuild_player_season_stats($1)`, [
          seasonId,
        ]);
        // Durable "done" flag so the self-healing sweeper won't re-enqueue it.
        await this.postgres.query(
          `UPDATE seasons SET needs_rebuild = false WHERE id = $1`,
          [seasonId],
        );
      }
    } finally {
      status.running = false;
      status.current_match_id = null;
      status.finished_at = new Date().toISOString();
      await this.saveStatus(status, FINAL_TTL_SECONDS);
      await this.cache.forget(CANCEL_KEY);
      // Per-row player_elo search events stay suppressed for the whole run: the
      // backfill recomputes ELO only and deliberately does NOT reindex the player
      // search index (use the manual "Reindex Search" action when desired).
      await this.eloRecompute.setSuppressEvents(false);
      await this.cache.forget(LOCK_KEY);

      this.logger.log(
        `[season-backfill] finished season ${seasonId}: ${status.completed}/${status.total} processed, ${status.failed} failed${status.canceled ? " (canceled)" : ""}`,
      );

      await this.notifyComplete(status);
    }
  }

  private async notifyComplete(status: SeasonEloBackfillStatus): Promise<void> {
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

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms`)),
        ms,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
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

  // When this is the first season ever AND it covers all history, the current
  // global ELO ladder is exactly this season's ladder — re-tag the global rows to
  // it (fast, and values are identical so the search index needs no reindex).
  // Returns the number of rows adopted, or null if the fast path doesn't apply.
  private async tryAdoptGlobalLadder(
    seasonId: string,
  ): Promise<number | null> {
    const eligibility = await this.postgres.query<
      Array<{ eligible: boolean }>
    >(
      `SELECT (
         -- no season has scoped ELO yet (this is the first season)
         NOT EXISTS (SELECT 1 FROM player_elo WHERE season_id IS NOT NULL)
         -- and there is no global (non-tournament) ELO before this season's start,
         -- i.e. the season covers all history so its ladder == the global ladder
         AND NOT EXISTS (
           SELECT 1
           FROM player_elo pe
           JOIN matches m ON m.id = pe.match_id
           WHERE pe.season_id IS NULL
             AND m.ended_at < (SELECT starts_at FROM seasons WHERE id = $1)
             AND NOT EXISTS (
               SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id
             )
         )
       ) AS eligible`,
      [seasonId],
    );

    if (!eligibility?.[0]?.eligible) {
      return null;
    }

    const tagged = await this.postgres.query<Array<{ count: string }>>(
      `WITH retagged AS (
         UPDATE player_elo pe
         SET season_id = $1
         FROM matches m
         WHERE pe.match_id = m.id
           AND m.source = '5stack'
           AND pe.season_id IS NULL
           AND season_for_timestamp(m.ended_at) = $1
           AND NOT EXISTS (
             SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id
           )
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM retagged`,
      [seasonId],
    );

    await this.postgres.query(`SELECT rebuild_player_season_stats($1)`, [
      seasonId,
    ]);

    const count = parseInt(tagged?.[0]?.count ?? "0", 10);
    this.logger.log(
      `[season-backfill] adopted the global ELO ladder for first season ${seasonId} (${count} rows re-tagged, no recompute/reindex needed)`,
    );
    return count;
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
      ORDER BY m.ended_at ASC, m.id ASC
      `,
      [seasonId],
    );
    return rows.map((row) => row.id);
  }
}
