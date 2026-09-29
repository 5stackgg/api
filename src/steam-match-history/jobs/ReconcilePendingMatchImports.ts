import { Logger } from "@nestjs/common";
import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";

// A pending import only leaves Queued/Parsing from inside its own job, so a job
// that stalls out, is lost, or finishes without deciding strands the row, and
// only Failed rows can be retried. This fails any row whose jobs are all done.
@UseQueue(
  "SteamMatchHistory",
  SteamMatchHistoryQueues.ReconcilePendingMatchImports,
)
export class ReconcilePendingMatchImports extends WorkerHost {
  // The row is written before its job is added, so a fresh row with no job
  // yet is not stranded.
  private static readonly GRACE = "15 minutes";

  private static readonly FINISHED_STATES = new Set([
    "completed",
    "failed",
    "unknown",
  ]);

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    @InjectQueue(SteamMatchHistoryQueues.ResolveMatchMetadata)
    private readonly resolveQueue: Queue,
    @InjectQueue(SteamMatchHistoryQueues.ParseImportedDemo)
    private readonly parseQueue: Queue,
  ) {
    super();
  }

  async process(): Promise<void> {
    const rows = await this.postgres.query<Array<{ valve_match_id: string }>>(
      `SELECT valve_match_id::text AS valve_match_id
         FROM public.pending_match_imports
        WHERE status IN ('Queued', 'Parsing')
          AND updated_at < now() - $1::interval`,
      [ReconcilePendingMatchImports.GRACE],
    );

    for (const { valve_match_id } of rows) {
      const jobs = (
        await Promise.all([
          this.resolveQueue.getJob(`resolve-${valve_match_id}`),
          this.parseQueue.getJob(`parse-${valve_match_id}`),
        ])
      ).filter((job): job is Job => !!job);

      const states = await Promise.all(jobs.map((job) => job.getState()));
      if (
        states.some(
          (state) => !ReconcilePendingMatchImports.FINISHED_STATES.has(state),
        )
      ) {
        continue;
      }

      const reason =
        jobs.map((job) => job.failedReason).find(Boolean) ??
        "import job ended without finishing the import";

      const failed = await this.postgres.query<
        Array<{ valve_match_id: string }>
      >(
        `UPDATE public.pending_match_imports
            SET status = 'Failed', error = $2
          WHERE valve_match_id = $1::numeric
            AND status IN ('Queued', 'Parsing')
            AND updated_at < now() - $3::interval
          RETURNING valve_match_id`,
        [valve_match_id, reason, ReconcilePendingMatchImports.GRACE],
      );
      if (failed.length > 0) {
        this.logger.warn(
          `reconcile-pending-match-imports failed stranded valve_match_id=${valve_match_id}: ${reason}`,
        );
      }
    }
  }
}
