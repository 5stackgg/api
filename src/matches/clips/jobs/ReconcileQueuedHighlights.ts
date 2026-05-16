import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../../enums/MatchQueues";
import { UseQueue } from "../../../utilities/QueueProcessors";
import { ClipsService } from "../clips.service";

@UseQueue("Clips", MatchQueues.Clips)
export class ReconcileQueuedHighlights extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly clips: ClipsService,
  ) {
    super();
  }

  async process(): Promise<number> {
    try {
      return await this.clips.reconcileQueuedHighlights();
    } catch (error) {
      this.logger.warn(
        `[reconcile-highlights] reconcile failed: ${(error as Error)?.message}`,
      );
      return 0;
    }
  }
}
