import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NadeQueues } from "../enums/NadeQueues";
import { NadeDriftService } from "../nade-drift.service";

// One at a time, because POST /drift serializes itself anyway: it holds two
// collision meshes for the life of a request, so a second concurrent scan waits
// on the parser instead of on this queue, where nothing can see it.
@UseQueue("Nades", NadeQueues.NadeDrift, { concurrency: 1 })
export class RunNadeDriftScan extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly drift: NadeDriftService,
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
        `RunNadeDriftScan ${scanId} failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
