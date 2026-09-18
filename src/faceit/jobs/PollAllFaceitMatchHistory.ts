import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { FaceitQueues } from "../enums/FaceitQueues";
import { FaceitMatchImportService } from "../faceit-match-import.service";
import { FaceitService } from "../faceit.service";

@UseQueue("Faceit", FaceitQueues.PollAllFaceitMatchHistory)
export class PollAllFaceitMatchHistory extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly faceit: FaceitService,
    private readonly faceitImport: FaceitMatchImportService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    // Piggybacks on the poll rather than carrying its own schedule. Ratings
    // feed the leaderboard, and refreshPlayer keeps its own per-player hourly
    // lock, so a busier poll does not mean more calls to faceit.
    try {
      const { refreshed, failed } = await this.faceit.refreshStaleRatings();

      if (refreshed || failed) {
        this.logger.log(
          `faceit ratings refreshed=${refreshed} failed=${failed}`,
        );
      }
    } catch (error) {
      // Never let the rating cache take the match import down with it.
      this.logger.warn(
        `faceit rating refresh pass failed: ${
          (error as Error)?.message ?? String(error)
        }`,
      );
    }

    await this.faceitImport.pollAllActive();
  }
}
