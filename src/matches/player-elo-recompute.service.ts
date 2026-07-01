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

// Status + cancel signal live in Redis so any API replica can read progress and
// request cancellation regardless of which pod is running the job.
const STATUS_KEY = "elo-recompute:status";
const CANCEL_KEY = "elo-recompute:cancel";
const LOCK_KEY = "elo-recompute:lock";

// Cross-pod flag so player_elo events (which fire on any replica) can be
// suppressed while the recompute rebuilds every row, then reindexed once.
const SUPPRESS_KEY = "elo-recompute:suppress-events";

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
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
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
  // is guaranteed by the concurrency-1 queue + jobId dedup, not by this flag.
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

  public async runRecomputeAll(): Promise<void> {
    // Hard single-execution guarantee: only the lock holder runs. Critical here
    // because the run TRUNCATEs player_elo — two overlapping runs would corrupt
    // the chronological rebuild. Duplicates (rapid clicks, multiple pods) no-op.
    if (!(await this.cache.acquireLock(LOCK_KEY, RUNNING_TTL_SECONDS))) {
      this.logger.warn("[elo-recompute] already running, skipping duplicate");
      return;
    }

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

      const ids = await this.fetchAllMatchIds();
      status.total = ids.length;
      await this.saveStatus(status, RUNNING_TTL_SECONDS);

      this.logger.log(
        `[elo-recompute] rebuilding ELO for ${ids.length} matches`,
      );

      for (const id of ids) {
        if (await this.isCancelRequested()) {
          status.canceled = true;
          this.logger.warn("[elo-recompute] canceled by request");
          break;
        }
        status.current_match_id = id;
        try {
          // Bounded so a hung query can't wedge the whole run (which would also
          // block the per-iteration cancel check).
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
          await this.cache.refreshLock(LOCK_KEY, RUNNING_TTL_SECONDS);
        }
      }
    } finally {
      status.running = false;
      status.current_match_id = null;
      status.finished_at = new Date().toISOString();
      await this.saveStatus(status, FINAL_TTL_SECONDS);
      await this.cache.forget(CANCEL_KEY);
      await this.cache.forget(SUPPRESS_KEY);
      await this.cache.forget(LOCK_KEY);

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
