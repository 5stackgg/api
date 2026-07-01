import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { CacheService } from "../cache/cache.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "../../generated";
import { TypeSenseService } from "./type-sense.service";

// Status + cancel signal live in Redis so any API replica can read progress and
// request cancellation regardless of which pod is running the job.
const STATUS_KEY = "player-reindex:status";
const CANCEL_KEY = "player-reindex:cancel";
const LOCK_KEY = "player-reindex:lock";

// Per-player cap so one hung Hasura/Typesense call can't freeze the whole run.
const ITEM_TIMEOUT_MS = 30_000;
// Heartbeat: while running the status key is refreshed with this TTL, so a
// hard-crashed run stops reporting "running" instead of muting forever.
const RUNNING_TTL_SECONDS = 300;
const FINAL_TTL_SECONDS = 7 * 24 * 3600;
const CANCEL_TTL_SECONDS = 600;

export type ReindexStatus = {
  running: boolean;
  canceled: boolean;
  started_at: string | null;
  finished_at: string | null;
  total: number;
  completed: number;
  failed: number;
  current_steam_id: string | null;
};

@Injectable()
export class PlayerReindexService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
    @Inject(forwardRef(() => TypeSenseService))
    private readonly typeSense: TypeSenseService,
  ) {}

  public async isRunning(): Promise<boolean> {
    return (await this.getStatus()).running;
  }

  public async requestCancel(): Promise<void> {
    if ((await this.getStatus()).running) {
      await this.cache.put(CANCEL_KEY, true, CANCEL_TTL_SECONDS);
    }
  }

  public async getStatus(): Promise<ReindexStatus> {
    return (await this.cache.get(STATUS_KEY)) ?? this.idleStatus();
  }

  private idleStatus(): ReindexStatus {
    return {
      running: false,
      canceled: false,
      started_at: null,
      finished_at: null,
      total: 0,
      completed: 0,
      failed: 0,
      current_steam_id: null,
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

  public async runReindexAll(): Promise<void> {
    // Hard single-execution guarantee: only the holder of this lock runs.
    // Any other queued/stacked job (from rapid clicks, elo completion, fixtures,
    // multiple pods) no-ops instead of running a duplicate.
    if (!(await this.cache.acquireLock(LOCK_KEY, RUNNING_TTL_SECONDS))) {
      this.logger.warn("[player-reindex] already running, skipping duplicate");
      return;
    }

    await this.cache.forget(CANCEL_KEY);

    const status: ReindexStatus = {
      ...this.idleStatus(),
      running: true,
      started_at: new Date().toISOString(),
    };
    await this.saveStatus(status, RUNNING_TTL_SECONDS);

    try {
      const steamIds = await this.fetchAllSteamIds();
      status.total = steamIds.length;
      await this.saveStatus(status, RUNNING_TTL_SECONDS);

      this.logger.log(`[player-reindex] reindexing ${steamIds.length} players`);

      for (const steamId of steamIds) {
        if (await this.isCancelRequested()) {
          status.canceled = true;
          this.logger.warn("[player-reindex] canceled by request");
          break;
        }
        status.current_steam_id = steamId;
        try {
          // Bounded so a hung Hasura/Typesense call can't wedge the whole run
          // (which would also block the per-iteration cancel check).
          await this.withTimeout(
            this.typeSense.updatePlayer(steamId),
            ITEM_TIMEOUT_MS,
          );
        } catch (error) {
          status.failed += 1;
          this.logger.warn(
            `[player-reindex] player ${steamId} failed: ${(error as Error)?.message}`,
          );
        }
        status.completed += 1;
        await this.saveStatus(status, RUNNING_TTL_SECONDS);
        await this.cache.refreshLock(LOCK_KEY, RUNNING_TTL_SECONDS);
      }
    } finally {
      status.running = false;
      status.current_steam_id = null;
      status.finished_at = new Date().toISOString();
      await this.saveStatus(status, FINAL_TTL_SECONDS);
      await this.cache.forget(CANCEL_KEY);
      await this.cache.forget(LOCK_KEY);
      this.logger.log(
        `[player-reindex] finished: ${status.completed}/${status.total} processed, ${status.failed} failed${status.canceled ? " (canceled)" : ""}`,
      );

      await this.notifyComplete(status);
    }
  }

  private async notifyComplete(status: ReindexStatus): Promise<void> {
    const duration = this.formatDuration(status.started_at, status.finished_at);
    const failedSuffix =
      status.failed > 0 ? ` <b>${status.failed}</b> failed.` : "";

    const title = status.canceled
      ? "Search reindex canceled"
      : "Search reindex complete";
    const verb = status.canceled ? "Canceled after reindexing" : "Reindexed";
    const message =
      `${verb} <b>${status.completed}</b> of <b>${status.total}</b> players ` +
      `in <b>${duration}</b>.${failedSuffix}`;

    try {
      await this.notifications.send(
        "PlayerReindex" as e_notification_types_enum,
        {
          title,
          message,
          role: "administrator" as e_player_roles_enum,
        },
      );
    } catch (error) {
      this.logger.warn(
        `[player-reindex] failed to send notification: ${(error as Error)?.message}`,
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

  private async saveStatus(status: ReindexStatus, ttl: number): Promise<void> {
    await this.cache.put(STATUS_KEY, status, ttl);
  }

  private async fetchAllSteamIds(): Promise<string[]> {
    const rows = await this.postgres.query<Array<{ steam_id: bigint }>>(
      `SELECT steam_id FROM players ORDER BY steam_id ASC`,
    );
    return rows.map((row) => row.steam_id.toString());
  }
}
