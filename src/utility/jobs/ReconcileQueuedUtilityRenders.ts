import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityRendersService } from "../utility-renders.service";

// Shares the renders queue, so it waits behind a running batch rather than
// re-dispatching underneath one. That is the same arrangement the highlights
// reconciler runs on, and the reason the module also reconciles once on boot:
// a restart is exactly when an orphaned row is most likely, and the boot call
// does not have to queue behind anything.
@UseQueue("Utility", UtilityQueues.UtilityRenders)
export class ReconcileQueuedUtilityRenders extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly renders: UtilityRendersService,
  ) {
    super();
  }

  public async process(): Promise<number> {
    try {
      return await this.renders.reconcileQueued();
    } catch (error) {
      this.logger.warn(
        `[utility-render] reconcile failed: ${(error as Error)?.message}`,
      );
      return 0;
    }
  }
}
