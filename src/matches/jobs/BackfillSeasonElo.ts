import { WorkerHost } from "@nestjs/bullmq";
import { DelayedError, Job } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { SeasonEloBackfillService } from "../season-elo-backfill.service";

@UseQueue("Matches", MatchQueues.SeasonEloBackfill, { concurrency: 1 })
export class BackfillSeasonElo extends WorkerHost {
  constructor(private readonly backfill: SeasonEloBackfillService) {
    super();
  }

  async process(job: Job<{ season_id: string }>): Promise<void> {
    if (!job.data?.season_id) {
      return;
    }
    if (await this.backfill.runBackfill(job.data.season_id)) {
      return;
    }
    await job.moveToDelayed(
      Date.now() + SeasonEloBackfillService.RETRY_DELAY_MS,
      job.token,
    );
    throw new DelayedError();
  }
}
