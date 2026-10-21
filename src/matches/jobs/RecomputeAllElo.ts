import { WorkerHost } from "@nestjs/bullmq";
import { DelayedError, Job } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PlayerEloRecomputeService } from "../player-elo-recompute.service";

@UseQueue("Matches", MatchQueues.EloRecompute, { concurrency: 1 })
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
