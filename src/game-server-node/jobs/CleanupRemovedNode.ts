import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { DelayedError, Job } from "bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NodeCleanupService } from "../node-cleanup.service";

// Hasura is always told its event was handled, so the queue retries a cleanup
// that could not read the cluster or delete everything. Every attempt checks
// the row and the Ready state again, so a node that came back keeps what it has.
@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class CleanupRemovedNode extends WorkerHost {
  // A node removed right after it went down is still Ready at first, and the
  // service then keeps it for NodeCleanupService.NOT_READY_GRACE_MS after k8s
  // marks it NotReady. Checking for twice that grace cleans a node that goes
  // NotReady within the grace after its removal. A node that is still running
  // gets its row back from its next ping within 30 s.
  public static readonly READY_CHECK_DELAY_MS = 60 * 1000;
  public static readonly READY_CHECKS = Math.ceil(
    (2 * NodeCleanupService.NOT_READY_GRACE_MS) /
      CleanupRemovedNode.READY_CHECK_DELAY_MS,
  );

  constructor(
    protected readonly logger: Logger,
    protected readonly nodeCleanup: NodeCleanupService,
  ) {
    super();
  }

  async process(
    job: Job<{ nodeId: string; readyChecks?: number }>,
  ): Promise<void> {
    const { nodeId, readyChecks = 0 } = job.data;

    const { failed, recently_ready } =
      await this.nodeCleanup.cleanupRemovedNodes(nodeId);
    if (failed > 0) {
      throw new Error(
        `unable to clean up removed node ${nodeId}: ${failed} delete(s) failed`,
      );
    }

    if (recently_ready === 0) {
      return;
    }

    if (readyChecks >= CleanupRemovedNode.READY_CHECKS) {
      this.logger.warn(
        `[node-cleanup] ${nodeId} is still Ready or went NotReady too recently, leaving it for the cleanup in the server settings`,
      );
      return;
    }

    await job.updateData({ ...job.data, readyChecks: readyChecks + 1 });
    await job.moveToDelayed(
      Date.now() + CleanupRemovedNode.READY_CHECK_DELAY_MS,
      job.token,
    );
    throw new DelayedError();
  }
}
