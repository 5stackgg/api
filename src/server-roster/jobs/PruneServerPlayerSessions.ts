import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ServerRosterQueues } from "../enums/ServerRosterQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { SystemSettingName } from "../../system/enums/SystemSettingName";

// Exact sessions are kept for the retention window, then folded into the
// all-time totals by prune_server_player_sessions in the same statement that
// deletes them. Batched so a backlog never holds one long transaction.
@UseQueue("ServerRoster", ServerRosterQueues.ServerRoster)
export class PruneServerPlayerSessions extends WorkerHost {
  public static readonly DEFAULT_RETENTION_DAYS = 7;
  public static readonly MIN_RETENTION_DAYS = 7;
  public static readonly MAX_RETENTION_DAYS = 90;

  private static readonly BATCH = 5000;
  private static readonly MAX_BATCHES = 200;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const days = await this.retentionDays();
    let pruned = 0;

    for (
      let batch = 0;
      batch < PruneServerPlayerSessions.MAX_BATCHES;
      batch++
    ) {
      const [row] = await this.postgres.query<Array<{ pruned: number }>>(
        `SELECT public.prune_server_player_sessions(
                    now() - make_interval(days => $1::int), $2::int) AS pruned`,
        [days, PruneServerPlayerSessions.BATCH],
      );

      pruned += row?.pruned ?? 0;

      if ((row?.pruned ?? 0) < PruneServerPlayerSessions.BATCH) {
        break;
      }
    }

    if (pruned > 0) {
      this.logger.log(
        `folded ${pruned} player session(s) older than ${days} days into the all-time totals`,
      );
    }
  }

  // Never below a week: the weekly leaderboards and charts read raw sessions.
  public static clampRetentionDays(value: unknown): number {
    const days = Number(value);

    if (!Number.isFinite(days)) {
      return PruneServerPlayerSessions.DEFAULT_RETENTION_DAYS;
    }

    return Math.min(
      Math.max(Math.floor(days), PruneServerPlayerSessions.MIN_RETENTION_DAYS),
      PruneServerPlayerSessions.MAX_RETENTION_DAYS,
    );
  }

  private async retentionDays(): Promise<number> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.PlayerSessionRetentionDays],
    );

    return PruneServerPlayerSessions.clampRetentionDays(row?.value);
  }
}
