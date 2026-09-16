import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ReconcileOnDemandServerJobs extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.matchAssistant.reconcileOnDemandServerJobs();
    } catch (error) {
      this.logger.error(
        `ReconcileOnDemandServerJobs failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
