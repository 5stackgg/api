import { DelayedError, Job } from "bullmq";
import { Logger } from "@nestjs/common";
import {
  OnQueueEvent,
  QueueEventsHost,
  QueueEventsListener,
  WorkerHost,
} from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import {
  GameStreamerService,
  NoGpuAvailableError,
  NoSteamAccountAvailableError,
} from "../../matches/game-streamer/game-streamer.service";
import { MatchAssistantService } from "../../matches/match-assistant/match-assistant.service";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityPracticeService } from "../utility-practice.service";
import { UtilityRendersService } from "../utility-renders.service";
import { UtilityRenderSpec } from "../types/UtilityRenderSpec";

const CHECK_DELAY_MS = 15_000;
const GPU_BUSY_RETRY_MS = 60_000;
const SERVER_BUSY_RETRY_MS = 60_000;
// The practice server is booted on demand; the pod's own wait for it is only
// 300s, so waiting for Ready here is cheaper than a GPU sitting idle.
const SERVER_READY_TIMEOUT_MS = 10 * 60 * 1000;

type JobData = {
  mapName: string;
  sessionId?: string;
  dispatched?: boolean;
  bookedAt?: number;
};

@UseQueue("Utility", UtilityQueues.UtilityRenders, { concurrency: 1 })
export class BatchUtilityRenderJob extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly renders: UtilityRendersService,
    private readonly practice: UtilityPracticeService,
    private readonly gameStreamer: GameStreamerService,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<void> {
    const { mapName } = job.data;
    const tag = `[nade-renders ${mapName}]`;

    const inFlight = await this.renders.inFlightForMap(mapName);
    if (inFlight.length === 0) {
      await this.releaseSession(job);
      this.logger.log(`${tag} nothing in flight — done`);
      return;
    }

    // STEP 1: a server for this map. One session films one map, so the batch
    // is the map's whole queue and the session is booked once for all of it.
    if (!job.data.sessionId) {
      await this.renders.stampBootStage(
        inFlight.map((render) => render.id),
        "booking_server",
      );
      let session;
      try {
        session = await this.practice.startForRender({
          mapName,
          hostSteamId: await this.hostFor(inFlight[0].id),
        });
      } catch (error) {
        const message = (error as Error)?.message ?? "no practice server";
        this.logger.log(`${tag} no practice server yet (${message})`);
        return this.delayUntilNext(job, SERVER_BUSY_RETRY_MS);
      }

      await this.renders.attachSession(
        inFlight.map((render) => render.id),
        session.id,
      );
      await this.renders.stampBootStage(
        inFlight.map((render) => render.id),
        "server_starting",
      );
      await job.updateData({
        ...job.data,
        sessionId: session.id,
        bookedAt: Date.now(),
      });
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    // STEP 2: the pod connects as a player, so nothing can be filmed until the
    // server is actually up and the practice plugin has asked for its session.
    if (!job.data.dispatched) {
      const session = await this.practice.session(job.data.sessionId);

      if (!session || !UtilityPracticeService.LIVE_STATUSES.includes(session.status)) {
        await this.renders.failRenders(
          inFlight.map((render) => render.id),
          await this.withServerLog(
            session?.match_id ?? null,
            `practice server never came up (${session?.failure_reason ?? session?.status ?? "session gone"})`,
          ),
        );
        await this.releaseSession(job);
        return;
      }

      if (session.status !== "Ready") {
        if (
          Date.now() - (job.data.bookedAt ?? Date.now()) >
          SERVER_READY_TIMEOUT_MS
        ) {
          // Before the teardown deletes the job: the pod's own words are the
          // only place the reason exists -- nothing in a practice pod pings.
          await this.renders.failRenders(
            inFlight.map((render) => render.id),
            await this.withServerLog(
              session.match_id,
              "practice server did not become ready in time",
            ),
          );
          await this.releaseSession(job);
          return;
        }

        // The server row's boot readout, folded in as a substage so the queue
        // shows Creating -> PullingImage -> WaitingForPing instead of a bare
        // "server starting" for ten minutes.
        const boot = await this.renders.bootStatusForMatch(session.match_id);
        if (boot?.boot_status) {
          await this.renders.stampBootStage(
            inFlight.map((render) => render.id),
            `server_starting:${boot.boot_status}`,
          );
        }

        return this.delayUntilNext(job, CHECK_DELAY_MS);
      }

      const connection = await this.practice.renderConnection(session.id);
      if (!connection) {
        return this.delayUntilNext(job, CHECK_DELAY_MS);
      }

      await this.renders.stampBootStage(
        inFlight.map((render) => render.id),
        "dispatching_pod",
      );
      try {
        const { jobName, nodeId } = await this.gameStreamer.dispatchNadePreviews(
          mapName,
          connection.match_id,
          { addr: connection.addr, password: connection.password },
          inFlight.map((render) => ({
            job_id: render.id,
            session_token: render.session_token,
            // Stamped here rather than at enqueue: it is a fact about the
            // server that ended up filming, and the pod refuses anything but
            // SwiftlyS2 -- it is the only runtime that can re-emit a throw.
            spec: {
              ...(render.spec as UtilityRenderSpec),
              plugin_runtime: connection.plugin_runtime,
            },
          })),
        );
        await this.renders.attachJobName(
          inFlight.map((render) => render.id),
          jobName,
          nodeId,
        );
      } catch (error) {
        if (error instanceof NoGpuAvailableError) {
          this.logger.debug(`${tag} no GPU free, retrying`);
          return this.delayUntilNext(job, GPU_BUSY_RETRY_MS);
        }
        if (error instanceof NoSteamAccountAvailableError) {
          this.logger.log(`${tag} no Steam account in the pool, retrying`);
          return this.delayUntilNext(job, GPU_BUSY_RETRY_MS);
        }
        const message = (error as Error)?.message ?? "dispatch failed";
        this.logger.error(`${tag} dispatch failed: ${message}`);
        await this.renders.failRenders(
          inFlight.map((render) => render.id),
          `dispatch failed: ${message}`,
        );
        await this.releaseSession(job);
        return;
      }

      await job.updateData({ ...job.data, dispatched: true });
      return this.delayUntilNext(job, CHECK_DELAY_MS * 2);
    }

    // STEP 3: the pod posts its own terminal status per lineup, so the only
    // thing left to watch is the pod outliving the rows.
    const podState = await this.gameStreamer.getNadeRenderPodState(mapName);
    if (podState === "running") {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    const reason =
      (await this.gameStreamer.getNadeRenderPodFailureReason(mapName)) ??
      (podState === "succeeded"
        ? "render pod exited before reporting terminal status"
        : podState === "failed"
          ? "render pod failed (k8s reported Job in failed state)"
          : "render pod no longer present (Job deleted)");

    this.logger.warn(
      `${tag} pod ${podState} with ${inFlight.length} lineup(s) still in flight — ${reason}`,
    );
    await this.renders.failRenders(
      inFlight.map((render) => render.id),
      reason,
    );
    await this.releaseSession(job);
  }

  // The practice server goes back to the pool the moment the batch is over --
  // it is a scarce resource and nobody is sitting on this one.
  private async releaseSession(job: Job<JobData>): Promise<void> {
    if (job.data.sessionId) {
      try {
        await this.practice.endRenderSession(job.data.sessionId);
      } catch (error) {
        this.logger.warn(
          `[nade-renders ${job.data.mapName}] releasing the practice session failed: ${(error as Error)?.message}`,
        );
      }
    }
    await job.updateData({
      mapName: job.data.mapName,
    });
    // The batch held a GPU. Hand it on the way the highlights job does, or a
    // live stream that was waiting on it sits there until something else
    // happens to free one.
    if (job.data.dispatched) {
      await this.onGpuFreed(job.data.mapName);
    }
  }

  private async onGpuFreed(mapName: string): Promise<void> {
    try {
      await this.gameStreamer.promotePendingLiveStreams();
    } catch (error) {
      this.logger.warn(
        `[nade-renders ${mapName}] onGpuFreed failed: ${(error as Error)?.message}`,
      );
    }
  }

  // Appends the practice-server pod's log tail to a failure reason. Best
  // effort: a reason without the log still fails the batch honestly.
  private async withServerLog(
    matchId: string | null,
    reason: string,
  ): Promise<string> {
    if (!matchId) return reason;
    try {
      const tail = await this.matchAssistant.getMatchServerLogTail(matchId);
      return tail ? `${reason} — ${tail}` : reason;
    } catch {
      return reason;
    }
  }

  private async hostFor(renderId: string): Promise<string> {
    const steamId = await this.renders.requesterFor(renderId);
    if (!steamId) {
      throw new Error("render has no requester to host its practice session");
    }
    return steamId;
  }

  private async delayUntilNext(job: Job, ms: number): Promise<void> {
    await job.moveToDelayed(Date.now() + ms, job.token);
    throw new DelayedError();
  }
}

@QueueEventsListener(UtilityQueues.UtilityRenders)
export class BatchUtilityRenderJobEvents extends QueueEventsHost {
  constructor(private readonly logger: Logger) {
    super();
  }

  @OnQueueEvent("failed")
  public async onFailed(args: { jobId: string; failedReason: string }) {
    this.logger.warn(
      `[nade-renders] BullMQ job ${args.jobId} failed: ${args.failedReason}`,
    );
  }
}
