import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityPracticeService } from "../utility-practice.service";
import { UtilityDiscoveryService } from "../utility-discovery.service";

@UseQueue("Utility", UtilityQueues.UtilityPractice)
export class ReapIdleUtilityPracticeSessions extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly practice: UtilityPracticeService,
    private readonly discoveries: UtilityDiscoveryService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.practice.reapIdle();
      await this.practice.reapRenderSessions();
      await this.discoveries.reapSessions();
      await this.discoveries.reconcile();
      // After the sessions, not before: reaping one is what turns its claim
      // into an orphan.
      await this.practice.releaseOrphanedServers();
    } catch (error) {
      this.logger.error(
        `ReapIdleUtilityPracticeSessions failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
