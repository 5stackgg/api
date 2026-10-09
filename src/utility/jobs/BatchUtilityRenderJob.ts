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
  NadeRenderPodBusyError,
  NoGpuAvailableError,
  NoSteamAccountAvailableError,
} from "../../matches/game-streamer/game-streamer.service";
import { MatchAssistantService } from "../../matches/match-assistant/match-assistant.service";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityPracticeService } from "../utility-practice.service";
import {
  UtilityRenderRow,
  UtilityRendersService,
} from "../utility-renders.service";
import { UtilityRenderSpec } from "../types/UtilityRenderSpec";

const CHECK_DELAY_MS = 15_000;
const GPU_BUSY_RETRY_MS = 60_000;
const SERVER_BUSY_RETRY_MS = 60_000;
// The practice server is booted on demand; the pod's own wait for it is only
// 300s, so waiting for Ready here is cheaper than a GPU sitting idle.
const SERVER_READY_TIMEOUT_MS = 10 * 60 * 1000;
// The server is already up and held for this batch; a GPU on its node that
// stays busy this long is not coming back in time to be worth the wait.
const GPU_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

// What a pod is started with. The list travels in one environment variable,
// which the kernel caps at 128KiB a string -- a recorded run-up is most of a
// lineup's size, and a map's whole queue of them does not fit. The pod asks
// for the rest as it goes, so the list only has to get it started; the row cap
// is what a pod that dies while booting takes down with it.
const FIRST_BATCH_MAX_BYTES = 96 * 1024;
const FIRST_BATCH_MAX_ROWS = 12;

// A pod whose queue has emptied waits a moment for more before it stops (the
// worker's own IDLE_SECONDS). One that is still up this long after the last
// render finished is not waiting, it is stuck.
const IDLE_POD_TIMEOUT_MS = 5 * 60 * 1000;

type JobData = {
  // The map the session was booked on. The pod moves the server on to the
  // queue's other maps by itself; the session row says where it is now.
  mapName?: string;
  sessionId?: string;
  dispatched?: boolean;
  // The pod the rows went to. Missing on a batch booked before the queue
  // shared one pod, which is found by its map instead.
  jobName?: string;
  // Only on a batch booked before rows carried their pod's name.
  dispatchedIds?: Array<string>;
  bookedAt?: number;
  gpuWaitSince?: number;
  idleSince?: number;
  // The wedge log is captured once per booking, two minutes in -- early
  // enough to read while it is still stuck, cheap enough to not spam k8s.
  podLogNoted?: boolean;
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
    const queue = await this.renders.inFlight();

    if (queue.length === 0) {
      return this.onEmptyQueue(job);
    }

    if (job.data.idleSince !== undefined) {
      await job.updateData({ ...job.data, idleSince: undefined });
    }

    // Booked when every map had a job of its own, and holding nothing any
    // more. What is left is the queue's one job's to film: a second job
    // working the same rows books a second server for them.
    if (
      job.id !== UtilityRendersService.WORKER_JOB_ID &&
      !job.data.sessionId
    ) {
      await this.renders.dispatch();
      return;
    }

    // What this job can still give a pod: the rows nobody has. Read only while
    // it has no pod of its own, so a row its pod was just handed is never
    // mistaken for one a dead pod left behind.
    let unclaimed: Array<UtilityRenderRow> = [];
    if (!job.data.dispatched) {
      // The api stopped between starting the pod and writing that down. The
      // pod is this job's all the same, and so is the session under it.
      const started = queue.find(
        (render) =>
          render.k8s_job_name !== null &&
          job.data.sessionId !== undefined &&
          render.utility_practice_session_id === job.data.sessionId,
      );
      if (started) {
        await this.practice.markRenderPod(
          job.data.sessionId,
          started.k8s_job_name,
        );
        await job.updateData({
          ...job.data,
          dispatched: true,
          jobName: started.k8s_job_name,
        });
        return this.delayUntilNext(job, CHECK_DELAY_MS);
      }

      unclaimed = (await this.failOrphans(queue)).filter(
        (render) => !render.k8s_job_name,
      );

      // Everything in flight is on a pod that is still up and is not this
      // job's -- one booked before the queue shared a pod. A second server
      // would have nothing to film.
      if (unclaimed.length === 0) {
        if (job.data.sessionId) {
          await this.releaseSession(job);
        }
        return this.delayUntilNext(job, CHECK_DELAY_MS);
      }
    }

    // STEP 1: a server on the map at the head of the queue. One session films
    // the whole queue: the pod takes the rest of that map as it goes, then
    // moves the server on to the next map itself.
    if (!job.data.sessionId) {
      const mapName = unclaimed[0].map_name;
      const tag = `[nade-renders ${mapName}]`;
      const inFlight = unclaimed.filter(
        (render) => render.map_name === mapName,
      );

      // No server can ever be booked on it, and that does not change by
      // waiting. Retried like "no server free yet" it would hold the head of
      // the queue for good, with every other map stuck behind it.
      if (!(await this.practice.canPracticeOn(mapName))) {
        this.logger.error(`${tag} is not a map a server can be booked on`);
        await this.renders.failRenders(
          inFlight.map((render) => render.id),
          `${mapName} is not available for practice, so no server can be booked on it`,
        );
        return this.again(job);
      }

      await this.renders.stampBootStage(
        inFlight.map((render) => render.id),
        "booking_server",
      );
      // Outside the try below: a render with no requester has nothing to host
      // its session and never will, so reading it as "no server yet" is a
      // once-a-minute retry that runs forever.
      let requestedBySteamId: string;
      try {
        requestedBySteamId = await this.requesterFor(inFlight[0].id);
      } catch (error) {
        const message = (error as Error)?.message ?? "no requester";
        this.logger.error(`${tag} cannot book a server: ${message}`);
        await this.renders.failRenders(
          inFlight.map((render) => render.id),
          message,
        );
        return this.again(job);
      }

      if ((await this.gameStreamer.freeRenderGpuNodeIds()).length === 0) {
        this.logger.log(`${tag} no GPU free to film on yet`);
        await this.renders.stampBootStage(
          inFlight.map((render) => render.id),
          "booking_server:NoGpuAvailable",
        );
        return this.delayUntilNext(job, GPU_BUSY_RETRY_MS);
      }

      let session;
      try {
        session = await this.practice.startForRender({
          mapName,
          requestedBySteamId,
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
      await this.renders.stampBootStage(
        unclaimed
          .filter((render) => render.map_name !== mapName)
          .map((render) => render.id),
        "waiting_for_map",
      );
      await job.updateData({
        ...job.data,
        mapName,
        sessionId: session.id,
        bookedAt: Date.now(),
      });
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    const mapName = job.data.mapName ?? queue[0].map_name;
    const tag = `[nade-renders ${mapName}]`;

    // STEP 2: the pod connects as a player, so nothing can be filmed until the
    // server is actually up and the practice plugin has asked for its session.
    if (!job.data.dispatched) {
      // What the pod starts with: the booked map's rows nobody has yet.
      const inFlight = unclaimed.filter(
        (render) => render.map_name === mapName,
      );

      // Everything on the booked map was cancelled before it was filmed. What
      // is left needs another map, and a pod cannot be started on nothing.
      if (inFlight.length === 0) {
        this.logger.log(`${tag} nothing left on this map — rebooking`);
        await this.releaseSession(job);
        return this.delayUntilNext(job, CHECK_DELAY_MS);
      }

      const session = await this.practice.session(job.data.sessionId);

      if (
        !session ||
        !UtilityPracticeService.LIVE_STATUSES.includes(session.status)
      ) {
        await this.renders.failRenders(
          inFlight.map((render) => render.id),
          await this.withServerLog(
            session?.match_id ?? null,
            `practice server never came up (${session?.failure_reason ?? session?.status ?? "session gone"})`,
          ),
        );
        await this.releaseSession(job);
        return this.again(job);
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
          return this.again(job);
        }

        // The server row's boot readout, folded in as a substage so the queue
        // shows Creating -> PullingImage -> WaitingForPing instead of a bare
        // "server starting" for ten minutes.
        const boot = await this.renders.bootStatusForMatch(session.match_id);
        this.logger.log(
          `${tag} waiting on practice server: session=${session.status} boot=${boot?.boot_status ?? "unassigned"} (${boot?.boot_status_detail ?? "no server reserved yet"})`,
        );
        if (boot?.boot_status) {
          await this.renders.stampBootStage(
            inFlight.map((render) => render.id),
            `server_starting:${boot.boot_status}`,
          );
        }

        // Two minutes of a pod that is Running but silent: pull its log once
        // and put it on the queued rows, so the reason is on screen while the
        // wedge is still happening rather than after the ten-minute timeout.
        const elapsed = Date.now() - (job.data.bookedAt ?? Date.now());
        if (
          !job.data.podLogNoted &&
          elapsed > 2 * 60 * 1000 &&
          boot?.boot_status === "WaitingForPing"
        ) {
          const tail = await this.matchAssistant.getMatchServerLogTail(
            session.match_id,
          );
          if (tail) {
            await this.renders.noteBootProblem(
              inFlight.map((render) => render.id),
              `practice server pod is up but silent — ${tail}`,
            );
          }
          await job.updateData({ ...job.data, podLogNoted: true });
        }

        return this.delayUntilNext(job, CHECK_DELAY_MS);
      }

      const connection = await this.practice.renderConnection(session.id);
      if (!connection) {
        return this.delayUntilNext(job, CHECK_DELAY_MS);
      }

      // Approved while the server was booting: the plugin serves the pod only
      // the lineups attached to its session, so a row left off it would be
      // staged against nothing.
      await this.renders.attachSession(
        inFlight.map((render) => render.id),
        session.id,
      );
      await this.renders.stampBootStage(
        inFlight.map((render) => render.id),
        "dispatching_pod",
      );
      const first = BatchUtilityRenderJob.firstBatch(
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
      let jobName: string;
      try {
        const dispatched = await this.gameStreamer.dispatchNadePreviews(
          mapName,
          connection.match_id,
          {
            addr: connection.addr,
            password: connection.password,
            nodeId: connection.node_id,
          },
          first,
        );
        jobName = dispatched.jobName;
        await this.practice.markRenderPod(session.id, dispatched.jobName);
        await this.renders.attachJobName(
          first.map((entry) => entry.job_id),
          dispatched.jobName,
          dispatched.nodeId,
        );
      } catch (error) {
        if (error instanceof NoGpuAvailableError) {
          const waitingSince = job.data.gpuWaitSince ?? Date.now();
          if (Date.now() - waitingSince > GPU_WAIT_TIMEOUT_MS) {
            await this.renders.failRenders(
              inFlight.map((render) => render.id),
              "the GPU on the practice server's node never came free",
            );
            await this.releaseSession(job);
            return this.again(job);
          }
          if (job.data.gpuWaitSince === undefined) {
            await job.updateData({ ...job.data, gpuWaitSince: waitingSince });
          }
          // Say it on the row, not at debug level: this retried invisibly for
          // minutes while the GPU block list counted the render's own
          // practice match against it.
          this.logger.log(`${tag} no GPU free, retrying`);
          await this.renders.stampBootStage(
            inFlight.map((render) => render.id),
            "dispatching_pod:NoGpuAvailable",
          );
          return this.delayUntilNext(job, GPU_BUSY_RETRY_MS);
        }
        if (error instanceof NadeRenderPodBusyError) {
          // The previous batch's Job is still terminating. Failing the queue
          // over a condition that clears in seconds is the expensive answer.
          this.logger.log(`${tag} a render pod is still up, retrying`);
          await this.renders.stampBootStage(
            inFlight.map((render) => render.id),
            "dispatching_pod:PodBusy",
          );
          return this.delayUntilNext(job, CHECK_DELAY_MS);
        }
        if (error instanceof NoSteamAccountAvailableError) {
          this.logger.log(`${tag} no Steam account in the pool, retrying`);
          await this.renders.stampBootStage(
            inFlight.map((render) => render.id),
            "dispatching_pod:NoSteamAccount",
          );
          return this.delayUntilNext(job, GPU_BUSY_RETRY_MS);
        }
        const message = (error as Error)?.message ?? "dispatch failed";
        this.logger.error(`${tag} dispatch failed: ${message}`);
        await this.renders.failRenders(
          inFlight.map((render) => render.id),
          `dispatch failed: ${message}`,
        );
        await this.releaseSession(job);
        return this.again(job);
      }

      await job.updateData({
        ...job.data,
        dispatched: true,
        jobName,
      });
      return this.delayUntilNext(job, CHECK_DELAY_MS * 2);
    }

    // STEP 3: the pod posts its own terminal status per lineup and asks for
    // its own next one, so the only thing left to watch is the pod outliving
    // the rows.
    const jobName = BatchUtilityRenderJob.podName(job.data);
    const podState = await this.gameStreamer.getNadeRenderPodState(jobName);
    if (podState === "running") {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    // Anything the pod was never handed is not its to fail. Failed here it
    // would need a moderator to cancel it by hand, because the in-flight
    // unique index refuses a second row for the same lineup.
    const dispatchedIds = job.data.dispatchedIds ?? [];
    const attempted = queue.filter(
      (render) =>
        dispatchedIds.includes(render.id) ||
        (render.k8s_job_name === jobName &&
          render.utility_practice_session_id === job.data.sessionId),
    );
    const untouched = queue.length - attempted.length;

    if (attempted.length > 0) {
      const reason =
        (await this.gameStreamer.getNadeRenderPodFailureReason(jobName)) ??
        (podState === "succeeded"
          ? "render pod exited before reporting terminal status"
          : podState === "failed"
            ? "render pod failed (k8s reported Job in failed state)"
            : "render pod no longer present (Job deleted)");

      this.logger.warn(
        `${tag} pod ${podState} with ${attempted.length} lineup(s) still in flight — ${reason}` +
          (untouched > 0 ? ` (${untouched} it never had, left alone)` : ""),
      );
      await this.renders.failRenders(
        attempted.map((render) => render.id),
        reason,
      );
    } else {
      this.logger.log(
        `${tag} pod ${podState}, ${untouched} lineup(s) queued since — booking again`,
      );
    }
    await this.releaseSession(job);

    // Those are this job's to film next: their own dispatch was dropped as a
    // duplicate of this job while it was live, so ending here would leave them
    // queued until the five-minute reconcile -- which is what a cancel followed
    // straight by a retry looked like.
    if (untouched > 0) {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }
  }

  /**
   * Fail whatever a pod that no longer exists was holding. Normally the job
   * that started a pod is watching it and does this itself; a row is only left
   * like this when that job was lost (a redis flush, say). Left alone it is in
   * flight forever: nothing films it, and the in-flight unique index refuses
   * its lineup a second row.
   *
   * Failed rather than put back, the same as when the watching job sees its
   * pod die: a pod that died once is as likely to die again, and failing is
   * what stops a server being booked for it in a loop.
   */
  private async failOrphans(
    queue: Array<UtilityRenderRow>,
  ): Promise<Array<UtilityRenderRow>> {
    const pods = [
      ...new Set(
        queue
          .map((render) => render.k8s_job_name)
          .filter((name): name is string => Boolean(name)),
      ),
    ];
    let failed = false;

    for (const pod of pods) {
      if ((await this.gameStreamer.getNadeRenderPodState(pod)) === "running") {
        continue;
      }

      const orphans = queue
        .filter((render) => render.k8s_job_name === pod)
        .map((render) => render.id);

      this.logger.warn(
        `[nade-renders] ${orphans.length} render(s) still held by ${pod}, which is gone — failing them`,
      );
      await this.renders.failRenders(
        orphans,
        "render pod no longer present (Job deleted)",
      );
      failed = true;
    }

    return failed ? this.renders.inFlight() : queue;
  }

  // The front of a map's queue, as much of it as fits in what a pod can be
  // started with. Always at least one: a lineup too big to start a pod with
  // alone is not made smaller by sending it later.
  public static firstBatch<T>(jobs: Array<T>): Array<T> {
    const first: Array<T> = [];
    let bytes = 2;

    for (const entry of jobs) {
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;

      if (
        first.length > 0 &&
        (first.length >= FIRST_BATCH_MAX_ROWS ||
          bytes + size > FIRST_BATCH_MAX_BYTES)
      ) {
        break;
      }

      first.push(entry);
      bytes += size;
    }

    return first;
  }

  // One map's rows failing is not the queue ending. This is the only job, so
  // returning with other maps still queued leaves them with nothing coming
  // until the five-minute reconcile.
  private async again(job: Job<JobData>): Promise<void> {
    if ((await this.renders.inFlight()).length > 0) {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }
  }

  private static podName(data: JobData): string {
    return (
      data.jobName ??
      GameStreamerService.GetLegacyNadeRenderJobName(data.mapName ?? "")
    );
  }

  // Nothing in flight. A pod that has run out of lineups is still up for a
  // moment, waiting on the next one, and its server is its to keep until it
  // stops; pulling the session out from under it would end that wait early.
  private async onEmptyQueue(job: Job<JobData>): Promise<void> {
    const tag = `[nade-renders ${job.data.mapName ?? "queue"}]`;

    if (job.data.dispatched) {
      const jobName = BatchUtilityRenderJob.podName(job.data);

      if ((await this.gameStreamer.getNadeRenderPodState(jobName)) === "running") {
        const idleSince = job.data.idleSince ?? Date.now();

        if (Date.now() - idleSince <= IDLE_POD_TIMEOUT_MS) {
          if (job.data.idleSince === undefined) {
            await job.updateData({ ...job.data, idleSince });
          }
          return this.delayUntilNext(job, CHECK_DELAY_MS);
        }

        this.logger.warn(`${tag} pod still up with nothing to film — stopping it`);
        await this.gameStreamer.killNadeRenderPod(jobName);
      }
    }

    await this.releaseSession(job);

    // A render approved while that ran had its own add() dropped as a
    // duplicate of this job, which is about to stop existing.
    if ((await this.renders.inFlight()).length > 0) {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    this.logger.log(`${tag} nothing in flight — done`);
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
    // Read before the data is cleared: updateData replaces job.data, so
    // asking afterwards whether a pod was dispatched always says no.
    const { dispatched, mapName } = job.data;
    await job.updateData({});
    // The batch held a GPU. Hand it on the way the highlights job does, or a
    // live stream that was waiting on it sits there until something else
    // happens to free one.
    if (dispatched) {
      await this.onGpuFreed(mapName ?? "queue");
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

  private async requesterFor(renderId: string): Promise<string> {
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
