import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { FaceitQueues } from "../enums/FaceitQueues";
import { FaceitMatchImportService } from "../faceit-match-import.service";

export type ImportFaceitMatchPayload = {
  faceit_match_id: string;
};

@UseQueue("Faceit", FaceitQueues.ImportFaceitMatch, {
  concurrency: 1,
  limiter: { max: 4, duration: 60_000 },
})
export class ImportFaceitMatch extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly faceitImport: FaceitMatchImportService,
  ) {
    super();
  }

  async process(job: Job<ImportFaceitMatchPayload>): Promise<void> {
    const { faceit_match_id } = job.data;

    const result = await this.faceitImport.importMatch(faceit_match_id);

    if (result.matchId) {
      this.logger.log(
        `import-faceit-match done faceit_match_id=${faceit_match_id} match_id=${result.matchId}${result.skipped ? ` (${result.skipped})` : ""}`,
      );
      return;
    }

    this.logger.warn(
      `import-faceit-match skipped faceit_match_id=${faceit_match_id}: ${result.skipped ?? "unknown reason"}`,
    );
  }
}
