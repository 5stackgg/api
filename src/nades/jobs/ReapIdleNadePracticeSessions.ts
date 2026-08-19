import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NadeQueues } from "../enums/NadeQueues";
import { NadePracticeService } from "../nade-practice.service";

@UseQueue("Nades", NadeQueues.NadePractice)
export class ReapIdleNadePracticeSessions extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly practice: NadePracticeService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.practice.reapIdle();
    } catch (error) {
      this.logger.error(
        `ReapIdleNadePracticeSessions failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
