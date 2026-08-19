import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityDriftService } from "../utility-drift.service";

// One at a time, because POST /drift serializes itself anyway: it holds two
// collision meshes for the life of a request, so a second concurrent scan waits
// on the parser instead of on this queue, where nothing can see it.
@UseQueue("Utility", UtilityQueues.UtilityDrift, { concurrency: 1 })
export class RunUtilityDriftScan extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly drift: UtilityDriftService,
  ) {
    super();
  }

  async process(job: Job<{ scan_id: string }>): Promise<void> {
    const scanId = job.data?.scan_id;

    if (!scanId) {
      return;
    }

    try {
      await this.drift.runScan(scanId);
    } catch (error) {
      this.logger.error(
        `RunUtilityDriftScan ${scanId} failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
