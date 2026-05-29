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
import {
  GameStreamerService,
  NoGpuAvailableError,
  NoSteamAccountAvailableError,
} from "../../game-streamer/game-streamer.service";
import { HasuraService } from "../../../hasura/hasura.service";
import { IN_FLIGHT_STATUSES } from "../clips.constants";

const CHECK_DELAY_MS = 10_000;
const GPU_BUSY_RETRY_MS = 60_000;
const STEAM_BUSY_RETRY_MS = 60_000;

@UseQueue("Clips", MatchQueues.Clips, {
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
      matchMapDemoId: string;
      dispatched?: boolean;
    }>,
  ): Promise<void> {
    const { matchMapId, matchMapDemoId, dispatched } = job.data;
    if (!matchMapDemoId) {
      throw new Error(
        `batch-highlights job ${job.id} missing matchMapDemoId — refusing to dispatch map-wide`,
      );
    }
    const tag = `[batch-highlights ${matchMapId} demo ${matchMapDemoId}]`;

    const inFlight = await this.fetchInFlightJobs(matchMapId, matchMapDemoId);
    if (inFlight.length === 0) {
      this.logger.log(`${tag} no in-flight clip_render_jobs — done`);
      return;
    }

    if (!dispatched) {
      this.logger.log(`${tag} dispatching ${inFlight.length} job(s)`);
      try {
        await this.gameStreamer.dispatchBatchHighlights(
          matchMapId,
          inFlight,
          matchMapDemoId,
        );
      } catch (error) {
        if (error instanceof NoGpuAvailableError) {
          this.logger.debug(
            `${tag} no GPU free, retrying in ${GPU_BUSY_RETRY_MS / 1000}s`,
          );
          return this.delayUntilNext(job, GPU_BUSY_RETRY_MS);
        }
        if (error instanceof NoSteamAccountAvailableError) {
          this.logger.log(
            `${tag} no Steam account in pool — add accounts under Settings → Steam Accounts. Retrying in ${STEAM_BUSY_RETRY_MS / 1000}s`,
          );
          return this.delayUntilNext(job, STEAM_BUSY_RETRY_MS);
        }
        const msg = (error as Error)?.message ?? "dispatch failed";
        this.logger.error(`${tag} dispatch failed: ${msg}`);
        await this.failInFlightJobs(
          inFlight.map((j) => j.id),
          `dispatch failed: ${msg}`,
        );
        return;
      }
      await job.updateData({ ...job.data, dispatched: true });
      return this.delayUntilNext(job, CHECK_DELAY_MS * 2);
    }

    const podState = await this.gameStreamer.getBatchHighlightsPodState(
      matchMapId,
      matchMapDemoId,
    );

    if (podState === "running") {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    const pausedQueued = await this.fetchPausedQueued(
      matchMapId,
      matchMapDemoId,
    );
    if (pausedQueued.length > 0 && podState !== "failed") {
      this.logger.log(
        `${tag} pod ${podState} with ${pausedQueued.length} queued+paused row(s) — paused exit`,
      );
      return;
    }

    const reason =
      (await this.gameStreamer.getBatchPodFailureReason(
        matchMapId,
        matchMapDemoId,
      )) ??
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
    await this.onGpuFreed(tag);
  }

  private async onGpuFreed(tag: string) {
    try {
      const { promoted } = await this.gameStreamer.promotePendingLiveStreams();
      if (promoted.length === 0) {
        await this.clips.resumeAllPausedBatches();
      }
    } catch (error) {
      this.logger.warn(
        `${tag} onGpuFreed failed: ${(error as Error)?.message}`,
      );
    }
  }

  private async fetchPausedQueued(
    matchMapId: string,
    matchMapDemoId: string,
  ): Promise<string[]> {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            match_map_demo_id: { _eq: matchMapDemoId },
            paused: { _eq: true },
            status: { _eq: "queued" },
          },
        },
        id: true,
      },
    });
    return (clip_render_jobs ?? []).map((r: any) => String(r.id));
  }

  private async delayUntilNext(job: Job, ms: number): Promise<void> {
    await job.moveToDelayed(Date.now() + ms, job.token);
    throw new DelayedError();
  }

  private async fetchInFlightJobs(
    matchMapId: string,
    matchMapDemoId: string,
  ): Promise<
    Array<{ id: string; job_id: string; session_token: string; spec: unknown }>
  > {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            match_map_demo_id: { _eq: matchMapDemoId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
            paused: { _eq: false },
          },
          order_by: [{ sort_index: "asc_nulls_last" }, { created_at: "asc" }],
        },
        id: true,
        session_token: true,
        spec: true,
      },
    });
    return (clip_render_jobs ?? [])
      .map((row: any) => ({
        id: String(row.id),
        job_id: String(row.id),
        session_token: String(row.session_token),
        spec: row.spec,
      }))
      .sort(ClipsService.compareHighlightJobs);
  }

  private async failInFlightJobs(jobIds: string[], reason: string) {
    if (jobIds.length === 0) return;
    await this.hasura.mutation({
      update_clip_render_jobs: {
        __args: {
          where: {
            id: { _in: jobIds },
            status: { _in: [...IN_FLIGHT_STATUSES] },
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

@QueueEventsListener(MatchQueues.Clips)
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
