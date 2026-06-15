import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { FaceitQueues } from "../enums/FaceitQueues";
import { FaceitMatchImportService } from "../faceit-match-import.service";

@UseQueue("Faceit", FaceitQueues.PollAllFaceitMatchHistory)
export class PollAllFaceitMatchHistory extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly faceitImport: FaceitMatchImportService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.faceitImport.pollAllActive();
  }
}
