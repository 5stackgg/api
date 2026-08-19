import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NadeQueues } from "../enums/NadeQueues";
import { NadeMetaService } from "../nade-meta.service";

// Inflating a demo blob is the expensive half of this, so the queue runs one
// job at a time: two concurrent passes would double the peak memory for no
// extra throughput.
@UseQueue("Nades", NadeQueues.NadeMeta, { concurrency: 1 })
export class MineNadeMeta extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly meta: NadeMetaService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.meta.mine();
    } catch (error) {
      this.logger.error(
        `MineNadeMeta failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
