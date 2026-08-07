import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
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
  }
}
