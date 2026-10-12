import { DelayedError, Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { e_match_types_enum } from "generated";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchmakeService } from "src/matchmaking/matchmake.service";

@UseQueue("Matchmaking", MatchmakingQueues.Matchmaking)
export class ExpandMatchmaking extends WorkerHost {
  constructor(private readonly matchmaking: MatchmakeService) {
    super();
  }

  async process(
    job: Job<{
      type: e_match_types_enum;
      region: string;
      failures?: number;
    }>,
  ): Promise<void> {
    const { type, region, failures = 0 } = job.data;

    const next = await this.matchmaking.matchmake(type, region, failures);

    if (!next) {
      return;
    }

    // The pass queued the next one under this job's id, which the job holds
    // until it finishes, so that add was dropped and the job goes back to the
    // delayed set itself.
    await job.updateData({ type, region, failures: next.failures });
    await job.moveToDelayed(Date.now() + next.delay, job.token);
    throw new DelayedError();
  }
}
