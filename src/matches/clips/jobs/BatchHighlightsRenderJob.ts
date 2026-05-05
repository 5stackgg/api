import { DelayedError, Job } from "bullmq";
import { Logger } from "@nestjs/common";
import {
  OnQueueEvent,
  QueueEventsHost,
  QueueEventsListener,
  WorkerHost,
} from "@nestjs/bullmq";
import { MatchQueues } from "../../enums/MatchQueues";
import { UseQueue } from "../../../utilities/QueueProcessors";
import { ClipsService } from "../clips.service";
import { GameStreamerService } from "../../game-streamer/game-streamer.service";
import { HasuraService } from "../../../hasura/hasura.service";

// Watchdog over the render pod for one match_map: dispatches once,
// then polls k8s state until in-flight rows clear or the pod dies.
const CHECK_DELAY_MS = 10_000;

@UseQueue("Matches", MatchQueues.ClipRenderBatch, {
  // One batch at a time — each takes a GPU.
  concurrency: 1,
})
export class BatchHighlightsRenderJob extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly clips: ClipsService,
    private readonly gameStreamer: GameStreamerService,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(
    job: Job<{
      matchMapId: string;
      dispatched?: boolean;
    }>,
  ): Promise<void> {
    const { matchMapId, dispatched } = job.data;
    const tag = `[batch-highlights ${matchMapId}]`;

    const inFlight = await this.fetchInFlightJobs(matchMapId);
    if (inFlight.length === 0) {
      this.logger.log(`${tag} no in-flight clip_render_jobs — done`);
      return;
    }

    // First poll: always clear any prior pod (24h ttl on k8s Jobs)
    // before dispatching, otherwise the state probe reads stale data.
    if (!dispatched) {
      this.logger.log(
        `${tag} dispatching ${inFlight.length} job(s) — clearing any prior pod first`,
      );
      try {
        await this.gameStreamer.killBatchHighlightsPod(matchMapId);
        await this.gameStreamer.dispatchBatchHighlights(matchMapId, inFlight);
      } catch (error) {
        const msg = (error as Error)?.message ?? "dispatch failed";
        this.logger.error(`${tag} dispatch failed: ${msg}`);
        await this.failInFlightJobs(
          inFlight.map((j) => j.id),
          `dispatch failed: ${msg}`,
        );
        return;
      }
      await job.updateData({ ...job.data, dispatched: true });
      // Longer first wait so the pod has time to come up.
      return this.delayUntilNext(job, CHECK_DELAY_MS * 2);
    }

    const podState =
      await this.gameStreamer.getBatchHighlightsPodState(matchMapId);

    if (podState === "running") {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    const reason =
      (await this.gameStreamer.getBatchPodFailureReason(matchMapId)) ??
      (podState === "succeeded"
        ? "render pod exited before reporting terminal status"
        : podState === "failed"
          ? "render pod failed (k8s reported Job in failed state)"
          : "render pod no longer present (Job deleted)");
    this.logger.warn(
      `${tag} pod ${podState} with ${inFlight.length} job(s) still in-flight — ${reason}`,
    );
    await this.failInFlightJobs(
      inFlight.map((j) => j.id),
      reason,
    );
  }

  private async delayUntilNext(job: Job, ms: number): Promise<void> {
    await job.moveToDelayed(Date.now() + ms, job.token);
    throw new DelayedError();
  }

  private async fetchInFlightJobs(
    matchMapId: string,
  ): Promise<
    Array<{ id: string; job_id: string; session_token: string; spec: unknown }>
  > {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: ["queued", "rendering", "uploading"] },
          },
          order_by: [{ created_at: "asc" }],
        },
        id: true,
        session_token: true,
        spec: true,
      },
    });
    return (clip_render_jobs ?? []).map((row: any) => ({
      id: String(row.id),
      job_id: String(row.id),
      session_token: String(row.session_token),
      spec: row.spec,
    }));
  }

  private async failInFlightJobs(jobIds: string[], reason: string) {
    if (jobIds.length === 0) return;
    await this.hasura.mutation({
      update_clip_render_jobs: {
        __args: {
          where: {
            id: { _in: jobIds },
            status: { _in: ["queued", "rendering", "uploading"] },
          },
          _set: {
            status: "error",
            error_message: reason,
            last_status_at: "now()",
          },
        },
        affected_rows: true,
      },
    });
  }
}

@QueueEventsListener(MatchQueues.ClipRenderBatch)
export class BatchHighlightsRenderJobEvents extends QueueEventsHost {
  constructor(private readonly logger: Logger) {
    super();
  }

  @OnQueueEvent("failed")
  public async onFailed(args: { jobId: string; failedReason: string }) {
    this.logger.warn(
      `[batch-highlights] BullMQ job ${args.jobId} failed: ${args.failedReason}`,
    );
  }
}
