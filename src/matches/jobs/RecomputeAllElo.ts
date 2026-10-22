import { WorkerHost } from "@nestjs/bullmq";
import { DelayedError, Job } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import {
  RESUMABLE_JOB_MAX_STALLS,
  UseQueue,
} from "../../utilities/QueueProcessors";
import { PlayerEloRecomputeService } from "../player-elo-recompute.service";

// A stalled run is started over rather than failed: giving up leaves player_elo
// half rebuilt until someone notices.
@UseQueue("Matches", MatchQueues.EloRecompute, {
  concurrency: 1,
  maxStalledCount: RESUMABLE_JOB_MAX_STALLS,
})
export class RecomputeAllElo extends WorkerHost {
  constructor(private readonly eloRecompute: PlayerEloRecomputeService) {
    super();
  }

  async process(job: Job<{ request?: number }>): Promise<void> {
    if (await this.eloRecompute.runRecomputeAll(job.data?.request)) {
      return;
    }
    await job.moveToDelayed(
      Date.now() + PlayerEloRecomputeService.RETRY_DELAY_MS,
      job.token,
    );
    throw new DelayedError();
  }
}
