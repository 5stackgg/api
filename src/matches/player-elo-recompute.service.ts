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

const PERSIST_EVERY = 25;
// Per-match cap so one hung query can't freeze the whole run.
const ITEM_TIMEOUT_MS = 60_000;
// Heartbeat: while running the status key is refreshed with this TTL, so a
// hard-crashed run stops reporting "running" instead of muting forever.
const RUNNING_TTL_SECONDS = 300;
const FINAL_TTL_SECONDS = 7 * 24 * 3600;
const CANCEL_TTL_SECONDS = 600;

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
    const request = await this.cache.increment(REQUEST_KEY);
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

  public async acquireRebuildLock(): Promise<string | null> {
    return await this.cache.acquireLock(LOCK_KEY, RUNNING_TTL_SECONDS);
  }

  public async refreshRebuildLock(token: string): Promise<void> {
    await this.cache.refreshLock(LOCK_KEY, token, RUNNING_TTL_SECONDS);
  }

  public async releaseRebuildLock(token: string): Promise<void> {
    await this.cache.releaseLock(LOCK_KEY, token);
  }

  public async isRebuilding(): Promise<boolean> {
    return (await this.cache.getRaw(LOCK_KEY)) !== null;
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

  // False means run it again later: another run holds the lock, and it may have
  // passed the matches this request was made for.
  public async runRecomputeAll(request?: number): Promise<boolean> {
    // Hard single-execution guarantee: only the lock holder runs. Critical here
    // because the run TRUNCATEs player_elo — two overlapping runs would corrupt
    // the chronological rebuild.
    const lockToken = await this.acquireRebuildLock();
    if (!lockToken) {
      this.logger.warn(
        "[elo-recompute] another rebuild holds the lock, retrying",
      );
      return false;
    }

    if (
      request !== undefined &&
      request <= ((await this.cache.get(COVERED_KEY)) ?? 0)
    ) {
      await this.settleQueuedStatus();
      await this.releaseRebuildLock(lockToken);
      return true;
    }

    const covers: number = (await this.cache.get(REQUEST_KEY)) ?? 0;

    await this.cache.forget(CANCEL_KEY);

    const status: EloRecomputeStatus = {
      ...this.idleStatus(),
      running: true,
      started_at: new Date().toISOString(),
    };
    await this.saveStatus(status, RUNNING_TTL_SECONDS);
    await this.cache.put(SUPPRESS_KEY, true, RUNNING_TTL_SECONDS);

    try {
      await this.postgres.query(`TRUNCATE TABLE player_elo`);

      const rebuilt = new Set<string>();
      let pending = await this.fetchAllMatchIds();

      this.logger.log(
        `[elo-recompute] rebuilding ELO for ${pending.length} matches`,
      );

      // A match that finished after the list was read is rated here too, so
      // the run never ends with a finished match missing from what it rebuilt.
      while (pending.length > 0 && !status.canceled) {
        status.total += pending.length;
        await this.saveStatus(status, RUNNING_TTL_SECONDS);

        for (const id of pending) {
          if (await this.isCancelRequested()) {
            status.canceled = true;
            this.logger.warn("[elo-recompute] canceled by request");
            break;
          }
          rebuilt.add(id);
          status.current_match_id = id;
          try {
            // Bounded so a hung query can't wedge the whole run (which would
            // also block the per-iteration cancel check).
            await this.withTimeout(
              this.postgres.query(`SELECT generate_player_elo_for_match($1)`, [
                id,
              ]),
              ITEM_TIMEOUT_MS,
            );
          } catch (error) {
            status.failed += 1;
            this.logger.warn(
              `[elo-recompute] match ${id} failed: ${(error as Error)?.message}`,
            );
          }
          status.completed += 1;
          if (status.completed % PERSIST_EVERY === 0) {
            await this.saveStatus(status, RUNNING_TTL_SECONDS);
            await this.cache.put(SUPPRESS_KEY, true, RUNNING_TTL_SECONDS);
            await this.refreshRebuildLock(lockToken);
          }
        }

        pending = (await this.fetchAllMatchIds()).filter(
          (id) => !rebuilt.has(id),
        );
      }

      if (!status.canceled) {
        await this.cache.put(COVERED_KEY, covers);
      }
    } finally {
      status.running = false;
      status.current_match_id = null;
      status.finished_at = new Date().toISOString();
      await this.saveStatus(status, FINAL_TTL_SECONDS);
      await this.cache.forget(CANCEL_KEY);
      await this.cache.forget(SUPPRESS_KEY);
      await this.releaseRebuildLock(lockToken);

      // Per-row player_elo events were suppressed during the run, so reindex
      // every player once here to sync search with the rebuilt ELO. Stable
      // jobId so it can't stack duplicate reindexes.
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

    return true;
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
      ORDER BY created_at ASC, id ASC
      `,
    );
    return rows.map((row) => row.id);
  }
}
