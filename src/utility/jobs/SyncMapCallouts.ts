import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityCalloutsService } from "../utility-callouts.service";

@UseQueue("Utility", UtilityQueues.UtilityMeta, { concurrency: 1 })
export class SyncMapCallouts extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly callouts: UtilityCalloutsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.callouts.syncAll();
    } catch (error) {
      this.logger.error(
        `SyncMapCallouts failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
