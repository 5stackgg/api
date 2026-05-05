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

// Observer of the render-pod lifecycle for one match_map. The pod
// is the actual processor — it loads cs2 once, runs through the
// entries in CLIP_BATCH_JOBS sequentially, and exits when done.
// This BullMQ job is a watchdog: dispatches the pod, polls its
// state, and surfaces failures.
//
// Each BullMQ job means "render this batch". We always treat it as
// a fresh re-render: any pre-existing k8s Job for this match_map
// (from a prior run still inside ttlSecondsAfterFinished, or a
// stuck pod, or whatever) is killed before we dispatch. This is
// what the operator pressing "Create Player Highlights" expects —
// the previous run's state should not silently shadow this one.
//
// Lifecycle, polled every CHECK_DELAY_MS via moveToDelayed:
//
//   First poll (data.dispatched is undefined):
//     1. Kill any existing k8s Job for this match_map.
//     2. Dispatch a fresh pod with the current in-flight rows.
//     3. Set data.dispatched=true and re-queue with a delay.
//
//   Subsequent polls (data.dispatched is true):
//     1. If 0 in-flight (queued/rendering/uploading) → DONE.
//     2. Read the pod's k8s Job state:
//        - running    → wait one more tick.
//        - succeeded  → pod exited cleanly. If rows are still
//                       in-flight, render script never POSTed
//                       terminal status — mark them error.
//        - failed     → container died. Pull the exit reason +
//                       log tail and mark rows error.
//        - absent     → Job got deleted out from under us
//                       (operator cancel, k8s reaped). Mark rows
//                       error.

const CHECK_DELAY_MS = 10_000;

@UseQueue("Matches", MatchQueues.ClipRenderBatch, {
  // Cap to one batch at a time across the whole api. Each batch
  // pod takes a GPU and several minutes — running two in parallel
  // doubles GPU pressure for the same total throughput. Bumping
  // this requires explicit operator intent.
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

    // First poll for this BullMQ attempt: always re-render. The k8s
    // Job name is keyed by match_map_id and we keep terminal Jobs
    // around for 24h, so any prior pod must be cleared out first —
    // otherwise the "what's the pod doing" probe below reads the
    // wrong run's state. The dispatched flag survives across the
    // delayed re-executions of this same BullMQ job.
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
      // First wait is longer — the pod needs a moment to come up.
      return this.delayUntilNext(job, CHECK_DELAY_MS * 2);
    }

    const podState =
      await this.gameStreamer.getBatchHighlightsPodState(matchMapId);

    if (podState === "running") {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    // succeeded / failed / absent → pod is done observing. Anything
    // still in-flight is stuck — pull the pod's exit reason if
    // there's one available and fail the rows so the operator sees
    // why instead of a row stuck rendering forever.
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
    await this.failInFlightJobs(inFlight.map((j) => j.id), reason);
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
    // We expose both `id` (used internally for fail-by-id) AND `job_id`
    // (the alias dispatchBatchHighlights expects in its env payload),
    // referring to the same uuid. Cheaper than mapping twice in the
    // caller.
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
