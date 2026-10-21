import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityPracticeService } from "../utility-practice.service";

@UseQueue("Utility", UtilityQueues.UtilityPractice)
export class ReapIdleUtilityPracticeSessions extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly practice: UtilityPracticeService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.practice.reapIdle();
    } catch (error) {
      this.logger.error(
        `ReapIdleUtilityPracticeSessions failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
