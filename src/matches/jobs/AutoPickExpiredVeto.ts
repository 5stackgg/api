import { DelayedError, Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

@UseQueue("Matches", MatchQueues.VetoTimeouts, { concurrency: 5 })
export class AutoPickExpiredVeto extends WorkerHost {
  constructor(private readonly postgres: PostgresService) {
    super();
  }

  async process(
    job: Job<{ matchId?: string; pickCount?: number } | undefined>,
  ): Promise<void> {
    const { matchId = null, pickCount = null } = job.data ?? {};

    // Both null is the fallback sweep: no fencing token, so it acts on any
    // expired veto whose per-match timer was lost. Casts are required —
    // Postgres cannot infer a parameter type from an untyped NULL.
    await this.postgres.query(
      "SELECT auto_pick_expired_veto($1::uuid, $2::int);",
      [matchId, pickCount],
    );

    if (!matchId) {
      return;
    }

    // The delay was measured on this pod's clock and the deadline is judged on
    // Postgres's, so a timer can land a moment early and pick nothing. It waits
    // out the rest rather than completing and leaving the turn to the sweep.
    const [early] = await this.postgres.query<Array<{ remaining_ms: number }>>(
      `SELECT ceil(extract(epoch FROM veto_pick_expires_at - now()) * 1000)::int AS remaining_ms
         FROM matches
        WHERE id = $1
          AND status = 'Veto'
          AND veto_pick_expires_at > now()
          AND veto_pick_count(id) = $2`,
      [matchId, pickCount],
    );

    if (early) {
      await job.moveToDelayed(Date.now() + early.remaining_ms + 250, job.token);
      throw new DelayedError();
    }
  }
}
