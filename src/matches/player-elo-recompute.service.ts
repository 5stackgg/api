import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PostgresService } from "../postgres/postgres.service";
import { CacheService } from "../cache/cache.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "../../generated";
import { TypesenseQueues } from "../type-sense/enums/TypesenseQueues";
import { RefreshAllPlayersJob } from "../type-sense/jobs/RefreshAllPlayers";
import { MatchQueues } from "./enums/MatchQueues";

// Status + cancel signal live in Redis so any API replica can read progress and
// request cancellation regardless of which pod is running the job.
const STATUS_KEY = "elo-recompute:status";
const CANCEL_KEY = "elo-recompute:cancel";
// Held by every bulk player_elo rebuild (this one and the season backfill) and
// waited out by a match's own rating, so none of them interleave.
const LOCK_KEY = "elo-recompute:lock";

// Cross-pod flag so player_elo events (which fire on any replica) can be
// suppressed while the recompute rebuilds every row, then reindexed once.
const SUPPRESS_KEY = "elo-recompute:suppress-events";

// Every request to recompute takes the next number. A run that finishes covers
// every request numbered up to the counter it read before touching any match,
// so a later job for one of those requests has nothing left to do.
const REQUEST_KEY = "elo-recompute:request";
const COVERED_KEY = "elo-recompute:covered";

const DEFERRED_KEY = "elo-recompute:deferred-ratings";

const PERSIST_EVERY = 25;
// Heartbeat: while running the status key is refreshed with this TTL, so a
// hard-crashed run stops reporting "running" instead of muting forever.
const RUNNING_TTL_SECONDS = 300;
const FINAL_TTL_SECONDS = 7 * 24 * 3600;
const CANCEL_TTL_SECONDS = 600;

// A formula rebuild's marker holds this and its request until a run covering
// that request finishes, then the time it did.
const FORMULA_PENDING = "elo-recompute-pending:";

export type RebuildLease = {
  renew(): Promise<boolean>;
  keepAlive(heartbeat?: () => Promise<void>): void;
  release(): Promise<void>;
};

export type RebuildProgress = {
  canceled: boolean;
  total: number;
  completed: number;
  failed: number;
  current_match_id: string | null;
};

export type EloRecomputeStatus = {
  running: boolean;
  canceled: boolean;
  started_at: string | null;
  finished_at: string | null;
  total: number;
  completed: number;
  failed: number;
  current_match_id: string | null;
};

@Injectable()
export class PlayerEloRecomputeService {
  public static readonly RETRY_DELAY_MS = 15_000;

  public static readonly LOCK_RENEW_MS = 60_000;

  // Postgres cancels a rating that runs this long, so it holds nothing after.
  public static readonly ITEM_TIMEOUT_MS = 60_000;

  // TRUNCATE waits behind every reader of player_elo and holds new readers
  // behind it, so it gives up on a reader that does not finish.
  public static readonly TRUNCATE_LOCK_TIMEOUT_MS = 10_000;

  public static jobId(request: number): string {
    return `elo-recompute.${request}`;
  }

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
    @InjectQueue(TypesenseQueues.PlayerReindex)
    private readonly reindexQueue: Queue,
    @InjectQueue(MatchQueues.EloRecompute)
    private readonly queue: Queue,
  ) {}

  public async isRunning(): Promise<boolean> {
    return (await this.getStatus()).running;
  }

  // Never skipped for a run already going: that run may be past the change.
  // Each request gets its own job id because BullMQ ignores an add whose id is
  // still active, and runRecomputeAll folds requests a run already covered.
  public async requestRecompute(): Promise<void> {
    await this.queueRecompute(await this.cache.increment(REQUEST_KEY));
  }

  private async queueRecompute(request: number): Promise<void> {
    if (!(await this.isRunning())) {
      await this.markQueued();
    }
    await this.queue.add(
      "RecomputeAllElo",
      { request },
      {
        jobId: PlayerEloRecomputeService.jobId(request),
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  // Renewed on a clock well inside its TTL rather than by progress: one slow
  // match, or a TRUNCATE queued behind readers, must not let it lapse. The
  // same clock carries the run's heartbeat, so a run blocked on one statement
  // still shows as running. A renewal that finds the lock gone is final, since
  // another rebuild may hold it now.
  public async acquireRebuildLease(): Promise<RebuildLease | null> {
    const token = await this.cache.acquireLock(LOCK_KEY, RUNNING_TTL_SECONDS);
    if (!token) {
      return null;
    }

    let held = true;
    let heartbeat: (() => Promise<void>) | undefined;
    const renew = async () => {
      held =
        held &&
        (await this.cache.refreshLock(LOCK_KEY, token, RUNNING_TTL_SECONDS));
      return held;
    };
    const timer = setInterval(() => {
      void (async () => {
        if ((await renew()) && heartbeat) {
          await heartbeat();
        }
      })().catch((error) =>
        this.logger.warn(
          `[elo-rebuild] heartbeat failed: ${(error as Error)?.message}`,
        ),
      );
    }, PlayerEloRecomputeService.LOCK_RENEW_MS);
    timer.unref();

    return {
      renew,
      keepAlive: (beat) => {
        heartbeat = beat;
      },
      release: async () => {
        clearInterval(timer);
        await this.cache.releaseLock(LOCK_KEY, token);
      },
    };
  }

  public async isRebuilding(): Promise<boolean> {
    return (await this.cache.getRaw(LOCK_KEY)) !== null;
  }

  // Rated by the rebuild holding the lock before it lets go, in the order the
  // matches finished, not whenever the match's own delayed job wakes.
  public async deferRating(matchId: string): Promise<void> {
    await this.cache.addToSet(DEFERRED_KEY, matchId);
  }

  // A change to how ratings are worked out needs every one rebuilt once. Asked
  // again on every boot until a run covering the request finishes: a run that
  // failed for good took its request with it.
  public async recomputeOnce(marker: string): Promise<void> {
    const [setting] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM settings WHERE name = $1`,
      [marker],
    );
    if (setting && !setting.value.startsWith(FORMULA_PENDING)) {
      return;
    }

    const request = await this.cache.increment(REQUEST_KEY);
    await this.postgres.query(
      `INSERT INTO settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [marker, `${FORMULA_PENDING}${request}`],
    );
    await this.queueRecompute(request);
  }

  // Rates the list in the order ratings chain (ended_at), then whatever it
  // holds now that it did not and every match whose own rating waited on the
  // lock, until a pass finds nothing new. False once the lock is lost: from
  // then on the caller must write nothing, the lock's new holder's deferred
  // ratings and status included.
  public async rateMatches(
    lease: RebuildLease,
    progress: RebuildProgress,
    list: () => Promise<Array<string>>,
    run: {
      label: string;
      isCanceled: () => Promise<boolean>;
      persist: () => Promise<void>;
    },
  ): Promise<boolean> {
    const holding = async () => {
      if (await lease.renew()) {
        return true;
      }
      this.logger.warn(`[${run.label}] lost the rebuild lock, stopping`);
      return false;
    };

    const rated = new Set<string>();
    let pending = await list();

    this.logger.log(
      `[${run.label}] rebuilding ELO for ${pending.length} matches`,
    );

    // At least once, so the deferred ratings are taken even when the list is
    // empty.
    do {
      if (!(await holding())) {
        return false;
      }
      progress.total += pending.length;
      await run.persist();

      for (const id of pending) {
        if (await run.isCanceled()) {
          progress.canceled = true;
          this.logger.warn(`[${run.label}] canceled by request`);
          return holding();
        }
        if (!(await holding())) {
          return false;
        }
        rated.add(id);
        progress.current_match_id = id;
        try {
          await this.rateMatch(id);
        } catch (error) {
          progress.failed += 1;
          this.logger.warn(
            `[${run.label}] match ${id} failed: ${(error as Error)?.message}`,
          );
        }
        progress.completed += 1;
        if (progress.completed % PERSIST_EVERY === 0) {
          if (!(await holding())) {
            return false;
          }
          await run.persist();
        }
      }

      const listed = await list();
      if (!(await holding())) {
        return false;
      }
      pending = await this.inEndedOrder(
        [...listed, ...(await this.cache.takeSet(DEFERRED_KEY))].filter(
          (id) => !rated.has(id),
        ),
      );
    } while (pending.length > 0);

    return holding();
  }

  // Postgres cancels it at ITEM_TIMEOUT_MS; the client gives up a little later
  // only for a connection that never answers at all.
  private async rateMatch(id: string): Promise<void> {
    const limit = PlayerEloRecomputeService.ITEM_TIMEOUT_MS;
    await this.withTimeout(
      this.postgres.transaction(async (client) => {
        await client.query(`SET LOCAL statement_timeout = ${limit}`);
        await client.query(`SELECT generate_player_elo_for_match($1)`, [id]);
      }),
      limit + 10_000,
    );
  }

  public async requestCancel(): Promise<void> {
    if ((await this.getStatus()).running) {
      await this.cache.put(CANCEL_KEY, true, CANCEL_TTL_SECONDS);
    }
  }

  public async getStatus(): Promise<EloRecomputeStatus> {
    return (await this.cache.get(STATUS_KEY)) ?? this.idleStatus();
  }

  // True while a recompute is rebuilding player_elo — used to suppress the
  // per-row player_elo search-sync events that would otherwise storm.
  public async isSuppressingEvents(): Promise<boolean> {
    return (await this.cache.get(SUPPRESS_KEY)) === true;
  }

  // Shared suppression toggle so other bulk player_elo rebuilders (e.g. the
  // season backfill job) reuse the same event-suppression window.
  public async setSuppressEvents(on: boolean): Promise<void> {
    if (on) {
      await this.cache.put(SUPPRESS_KEY, true, RUNNING_TTL_SECONDS);
    } else {
      await this.cache.forget(SUPPRESS_KEY);
    }
  }

  private idleStatus(): EloRecomputeStatus {
    return {
      running: false,
      canceled: false,
      started_at: null,
      finished_at: null,
      total: 0,
      completed: 0,
      failed: 0,
      current_match_id: null,
    };
  }

  // Reset progress the moment a run is requested so the UI never shows the
  // previous run's stale totals while the job is still queued. Single-execution
  // is guaranteed by the run's lock, not by this flag.
  public async markQueued(): Promise<void> {
    await this.cache.forget(CANCEL_KEY);
    await this.saveStatus(
      {
        ...this.idleStatus(),
        running: true,
        started_at: new Date().toISOString(),
      },
      RUNNING_TTL_SECONDS,
    );
  }

  // False means run it again later: another rebuild holds the lock or took it
  // over, and this request's matches may not have been rated since its change.
  public async runRecomputeAll(request?: number): Promise<boolean> {
    // Hard single-execution guarantee: only the lock holder runs. Critical here
    // because the run TRUNCATEs player_elo — two overlapping runs would corrupt
    // the chronological rebuild.
    const lease = await this.acquireRebuildLease();
    if (!lease) {
      this.logger.warn(
        "[elo-recompute] another rebuild holds the lock, retrying",
      );
      return false;
    }

    try {
      if (
        request !== undefined &&
        request <= ((await this.cache.get(COVERED_KEY)) ?? 0)
      ) {
        await this.settleQueuedStatus();
        return true;
      }

      return await this.rebuildAll(lease);
    } finally {
      await lease.release();
    }
  }

  private async rebuildAll(lease: RebuildLease): Promise<boolean> {
    const covers: number = (await this.cache.get(REQUEST_KEY)) ?? 0;

    await this.cache.forget(CANCEL_KEY);

    const status: EloRecomputeStatus = {
      ...this.idleStatus(),
      running: true,
      started_at: new Date().toISOString(),
    };
    const persist = async () => {
      await this.saveStatus(status, RUNNING_TTL_SECONDS);
      await this.cache.put(SUPPRESS_KEY, true, RUNNING_TTL_SECONDS);
    };
    await persist();
    lease.keepAlive(persist);

    let finished = false;
    try {
      if (!(await this.truncateRatings())) {
        return false;
      }

      if (
        !(await this.rateMatches(lease, status, () => this.fetchAllMatchIds(), {
          label: "elo-recompute",
          isCanceled: () => this.isCancelRequested(),
          persist,
        }))
      ) {
        return false;
      }

      if (!status.canceled) {
        if (!(await lease.renew())) {
          return false;
        }
        await this.cache.put(COVERED_KEY, covers);
        await this.markFormulaRebuildsDone(covers);
      }

      finished = true;
    } finally {
      // A lost lock leaves the status, suppression and reindex to whichever
      // rebuild holds it now. A run that threw is retried, and tells nobody it
      // finished.
      lease.keepAlive();
      if (await lease.renew()) {
        status.running = false;
        status.current_match_id = null;
        status.finished_at = new Date().toISOString();
        await this.saveStatus(status, FINAL_TTL_SECONDS);
        await this.cache.forget(CANCEL_KEY);
        await this.cache.forget(SUPPRESS_KEY);

        if (finished) {
          // Per-row player_elo events were suppressed during the run, so
          // reindex every player once here to sync search with the rebuilt ELO.
          // Stable jobId so it can't stack duplicate reindexes.
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
            `[elo-recompute] finished: ${status.completed}/${status.total} processed, ${status.failed} failed${status.canceled ? " (canceled)" : ""}`,
          );

          await this.notifyComplete(status);
        }
      }
    }

    return true;
  }

  private async truncateRatings(): Promise<boolean> {
    try {
      await this.postgres.transaction(async (client) => {
        await client.query(
          `SET LOCAL lock_timeout = ${PlayerEloRecomputeService.TRUNCATE_LOCK_TIMEOUT_MS}`,
        );
        await client.query(`TRUNCATE TABLE player_elo`);
      });
      return true;
    } catch (error) {
      if ((error as { code?: string })?.code === "55P03") {
        this.logger.warn(
          "[elo-recompute] another query holds player_elo, retrying",
        );
        return false;
      }
      throw error;
    }
  }

  private async markFormulaRebuildsDone(covers: number): Promise<void> {
    await this.postgres.query(
      `UPDATE settings SET value = $3
        WHERE starts_with(value, $2)
          AND substring(value FROM length($2) + 1)::bigint <= $1`,
      [covers, FORMULA_PENDING, new Date().toISOString()],
    );
  }

  // Holding the lock means no run is going, so a running status here is the
  // queued snapshot of a request an earlier run already covered.
  private async settleQueuedStatus(): Promise<void> {
    const status = await this.getStatus();
    if (!status.running) {
      return;
    }
    await this.saveStatus(
      { ...status, running: false, finished_at: new Date().toISOString() },
      FINAL_TTL_SECONDS,
    );
  }

  private async notifyComplete(status: EloRecomputeStatus): Promise<void> {
    const duration = this.formatDuration(status.started_at, status.finished_at);
    const failedSuffix =
      status.failed > 0 ? ` <b>${status.failed}</b> failed.` : "";

    const title = status.canceled
      ? "ELO recompute canceled"
      : "ELO recompute complete";
    const verb = status.canceled ? "Canceled after rebuilding" : "Rebuilt";
    const message =
      `${verb} ELO for <b>${status.completed}</b> of <b>${status.total}</b> matches ` +
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
        `[elo-recompute] failed to send notification: ${(error as Error)?.message}`,
      );
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
    status: EloRecomputeStatus,
    ttl: number,
  ): Promise<void> {
    await this.cache.put(STATUS_KEY, status, ttl);
  }

  private async fetchAllMatchIds(): Promise<string[]> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `
      SELECT id::text AS id
      FROM matches
      WHERE ended_at IS NOT NULL
        AND winning_lineup_id IS NOT NULL
      ORDER BY ended_at ASC, created_at ASC, id ASC
      `,
    );
    return rows.map((row) => row.id);
  }

  private async inEndedOrder(ids: Array<string>): Promise<Array<string>> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `
      SELECT id::text AS id
      FROM matches
      WHERE id = ANY($1::uuid[])
      ORDER BY ended_at ASC, created_at ASC, id ASC
      `,
      [[...new Set(ids)]],
    );
    return rows.map((row) => row.id);
  }
}
