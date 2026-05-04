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
// state + the clip_render_jobs rows, and surfaces failures.
//
// One BullMQ job per match_map_id (deduped via jobId). Worker
// concurrency on the queue is 1 so the GPU pod budget across the
// platform is bounded regardless of how many match_maps are
// queued.
//
// Lifecycle, polled every CHECK_DELAY_MS via moveToDelayed:
//
//   1. Look at clip_render_jobs for this match_map.
//      - If 0 in-flight (queued / rendering / uploading) → DONE.
//   2. Look at the pod's k8s Job.
//      - "absent"   → no pod yet → dispatch.
//      - "running"  → pod alive → wait one more tick. We never
//                     preempt. If the operator genuinely wants to
//                     stop a runaway pod they can use the
//                     "Cancel batch" button on the queue page,
//                     which kills the pod through an explicit
//                     authorised path (cancelClipRenderBatch).
//      - "succeeded"→ pod exited cleanly. If clip rows still
//                     in-flight, the pod failed to upload them
//                     before exiting; mark them error and DONE.
//      - "failed"   → k8s reports the Job hit backoffLimit (the
//                     container died). We DO NOT auto-redispatch
//                     — most permanent failures (bad presigned
//                     URL, missing demo, image pull error, etc.)
//                     would just trip again immediately and the
//                     repeated "force-killed pod" log noise reads
//                     like we're being aggressive when we're
//                     actually just observing a pod that already
//                     died. Mark rows error with the pod's exit
//                     reason and exit. Operator retries via
//                     "Create Player Highlights".

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
    }>,
  ): Promise<void> {
    const { matchMapId } = job.data;
    const tag = `[batch-highlights ${matchMapId}]`;

    // 1. What's left to do for this match_map?
    const inFlight = await this.fetchInFlightJobs(matchMapId);
    if (inFlight.length === 0) {
      this.logger.log(`${tag} no in-flight clip_render_jobs — done`);
      return;
    }

    // 2. Pod state.
    const podState =
      await this.gameStreamer.getBatchHighlightsPodState(matchMapId);

    if (podState === "absent") {
      this.logger.log(
        `${tag} no pod — dispatching ${inFlight.length} in-flight job(s)`,
      );
      await this.gameStreamer.dispatchBatchHighlights(matchMapId, inFlight);
      // First poll waits a bit longer to give the pod time to come up.
      return this.delayUntilNext(job, CHECK_DELAY_MS * 2);
    }

    if (podState === "running") {
      // Pod is processing the batch. Wait — never preempt. The pod
      // owns its own lifecycle; killing it here would lose the rest
      // of the batch it's about to render against the same already-
      // loaded cs2 instance.
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    if (podState === "succeeded") {
      // Pod exited 0 but rows are still in-flight — most often this
      // means the inline render script bailed out early (missing env,
      // demo never loaded, spec-server unreachable) before it ever
      // POSTed status=error back to the api. Pull the pod's last
      // log lines so the operator sees the real reason on the row
      // (and in this warning) instead of a generic "exited before
      // upload" string with no context.
      const reason =
        (await this.gameStreamer.getBatchPodFailureReason(matchMapId)) ??
        "render pod exited before upload";
      this.logger.warn(
        `${tag} pod exited cleanly but ${inFlight.length} job(s) never reached terminal state — ${reason}`,
      );
      await this.failInFlightJobs(inFlight.map((j) => j.id), reason);
      return;
    }

    // podState === "failed". k8s declared the container dead.
    // We DO NOT auto-redispatch — pull the most recent pod's exit
    // reason / log tail so the operator can see WHY (bad presigned
    // URL, missing demo, image pull, etc.) and let them decide
    // whether to manually retry via "Create Player Highlights".
    // Repeated automatic redispatches with identical inputs almost
    // never recover, and the resulting "force-killed pod" log
    // stream looks like we're killing healthy pods even though
    // we're observing already-dead ones.
    const failureReason =
      (await this.gameStreamer.getBatchPodFailureReason(matchMapId)) ??
      "render pod failed (k8s reported the Job in failed state)";
    this.logger.warn(
      `${tag} pod failed: ${failureReason} — marking ${inFlight.length} in-flight row(s) error (NO redispatch)`,
    );
    await this.failInFlightJobs(
      inFlight.map((j) => j.id),
      failureReason,
    );
    // Leave the failed k8s Job resource around for ~ttl so the
    // operator can `kubectl logs` against it. The k8s Job's
    // ttlSecondsAfterFinished (24h) reaps it automatically.
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
