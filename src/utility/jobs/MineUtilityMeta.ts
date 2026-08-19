import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityMetaService } from "../utility-meta.service";

// Inflating a demo blob is the expensive half of this, so the queue runs one
// job at a time: two concurrent passes would double the peak memory for no
// extra throughput.
@UseQueue("Utility", UtilityQueues.UtilityMeta, { concurrency: 1 })
export class MineUtilityMeta extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly meta: UtilityMetaService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.meta.mine();
    } catch (error) {
      this.logger.error(
        `MineUtilityMeta failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
