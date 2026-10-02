import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { DelayedError, Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityCalloutsService } from "../utility-callouts.service";

type SyncMapCalloutsData = {
  buildId?: number;
};

@UseQueue("Utility", UtilityQueues.UtilityMeta, { concurrency: 1 })
export class SyncMapCallouts extends WorkerHost {
  public static readonly WAIT_INTERVAL_MS = 15 * 60 * 1000;

  // Past this the build is synced from whatever is published: a fresh install
  // whose first node lands mid-publish still gets callouts, and an operator who
  // never publishes a build does not leave the job waiting for ever.
  public static readonly MAX_WAIT_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly logger: Logger,
    private readonly callouts: UtilityCalloutsService,
  ) {
    super();
  }

  async process(job: Job<SyncMapCalloutsData>): Promise<void> {
    const buildId = job.data?.buildId;

    if (
      buildId &&
      Date.now() - job.timestamp < SyncMapCallouts.MAX_WAIT_MS &&
      !(await this.callouts.hasPublished(buildId))
    ) {
      await job.moveToDelayed(
        Date.now() + SyncMapCallouts.WAIT_INTERVAL_MS,
        job.token,
      );
      throw new DelayedError();
    }

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
