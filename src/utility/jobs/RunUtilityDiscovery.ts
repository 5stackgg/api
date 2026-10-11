import { DelayedError, Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import {
  RESUMABLE_JOB_MAX_STALLS,
  UseQueue,
} from "../../utilities/QueueProcessors";
import { UtilityQueues } from "../enums/UtilityQueues";
import { UtilityPracticeService } from "../utility-practice.service";
import { UtilityLoadService } from "../utility-load.service";
import {
  UtilityDiscoveryHead,
  UtilityDiscoveryService,
} from "../utility-discovery.service";

const CHECK_DELAY_MS = 10_000;
const POLL_DELAY_MS = 5_000;
const SERVER_BUSY_RETRY_MS = 30_000;
const SERVER_READY_TIMEOUT_MS = 10 * 60 * 1000;
const MAP_CHANGE_TIMEOUT_MS = 3 * 60 * 1000;
// Nobody waits this long for a server to come free; they have moved on. Timed
// from the first failed booking, not from the request: behind other searches
// on a server that is working, waiting is the queue doing its job.
const BOOKING_TIMEOUT_MS = 20 * 60 * 1000;
// The plugin stops itself at max_seconds and reports what it has; past this it
// has gone quiet.
const VERIFY_GRACE_MS = 2 * 60 * 1000;
// A server that has just finished one is kept for the next: booking a cold one
// costs a minute or two.
const WARM_MS = 3 * 60 * 1000;
const RUN_ATTEMPTS = 3;

type JobData = {
  sessionId?: string;
  bookedAt?: number;
  mapChangeAt?: number;
  runAttempts?: number;
  idleSince?: number;
  bookingSince?: number;
};

@UseQueue("Utility", UtilityQueues.UtilityDiscovery, {
  concurrency: 1,
  maxStalledCount: RESUMABLE_JOB_MAX_STALLS,
})
export class RunUtilityDiscovery extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly discoveries: UtilityDiscoveryService,
    private readonly practice: UtilityPracticeService,
    private readonly load: UtilityLoadService,
  ) {
    super();
  }

  // A throw that is not BullMQ's own control flow would fail the job, and the
  // failed job takes the session it was holding with it: the server stays up
  // with nothing to end it, and the next job books a second one.
  async process(job: Job<JobData>): Promise<void> {
    try {
      await this.step(job);
    } catch (error) {
      if (error instanceof DelayedError) {
        throw error;
      }
      this.logger.error(
        `[utility-discovery] step failed, retrying: ${(error as Error)?.message}`,
      );
      await this.delayUntilNext(job, CHECK_DELAY_MS);
    }
  }

  private async step(job: Job<JobData>): Promise<void> {
    const head = await this.discoveries.next();

    if (!head) {
      return this.onEmptyQueue(job);
    }

    if (job.data.idleSince !== undefined) {
      await this.patch(job, { idleSince: undefined });
    }

    const tag = `[utility-discovery ${head.id}]`;

    if (
      head.status === "Verifying" &&
      head.utility_practice_session_id !== job.data.sessionId
    ) {
      this.logger.warn(`${tag} its server is no longer held, failing it`);
      if (head.utility_practice_session_id) {
        const serverId = await this.practice.renderServerId(
          head.utility_practice_session_id,
        );
        if (serverId) {
          await this.load.discovery(serverId, "cancel", head.id);
        }
        await this.practice.endRenderSession(head.utility_practice_session_id);
      }
      await this.discoveries.finish(
        head.id,
        "Failed",
        "the server throwing it was lost",
      );
      return this.delayUntilNext(job, 0);
    }

    if (!job.data.sessionId) {
      return this.book(job, head);
    }

    const session = await this.practice.session(job.data.sessionId);

    if (
      !session ||
      !UtilityPracticeService.LIVE_STATUSES.includes(session.status)
    ) {
      this.logger.warn(
        `${tag} the server went away (${session?.failure_reason ?? session?.status ?? "session gone"})`,
      );
      if (head.status === "Verifying") {
        await this.discoveries.finish(head.id, "Failed", "the server stopped");
      }
      await this.release(job);
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    if (session.status !== "Ready") {
      if (
        Date.now() - (job.data.bookedAt ?? Date.now()) >
        SERVER_READY_TIMEOUT_MS
      ) {
        await this.discoveries.finish(
          head.id,
          "Failed",
          "the server did not come up in time",
        );
        await this.release(job);
        return this.delayUntilNext(job, 0);
      }
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    if (session.map_name !== head.map_name) {
      return this.changeMap(job, head, session.id);
    }

    const changing = await this.mapChangingMs(session.match_id);
    if (changing !== null) {
      if (changing > MAP_CHANGE_TIMEOUT_MS) {
        this.logger.warn(
          `${tag} the server never came back from the map change`,
        );
        await this.release(job);
      }
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    if (head.status === "Queued") {
      return this.run(job, head, session.id);
    }

    const started = head.started_at ? new Date(head.started_at).getTime() : 0;
    if (
      Date.now() - started >
      UtilityDiscoveryService.MAX_SECONDS * 1000 + VERIFY_GRACE_MS
    ) {
      this.logger.warn(`${tag} the server never said it was done`);
      const serverId = await this.practice.renderServerId(session.id);
      if (serverId) {
        await this.load.discovery(serverId, "cancel", head.id);
      }
      await this.discoveries.finish(
        head.id,
        "Failed",
        "the server did not finish in time",
      );
      return this.delayUntilNext(job, 0);
    }

    return this.delayUntilNext(job, POLL_DELAY_MS);
  }

  private async book(job: Job<JobData>, head: UtilityDiscoveryHead) {
    const tag = `[utility-discovery ${head.id}]`;

    if (!(await this.practice.canPracticeOn(head.map_name))) {
      await this.discoveries.finish(
        head.id,
        "Failed",
        `${head.map_name} is not available for practice`,
      );
      return this.delayUntilNext(job, 0);
    }

    let session;
    try {
      session = await this.practice.startForRender({
        mapName: head.map_name,
        requestedBySteamId: head.requested_by_steam_id,
        isDiscovery: true,
      });
    } catch (error) {
      this.logger.log(
        `${tag} no server yet (${(error as Error)?.message ?? "unknown"})`,
      );
      const since = job.data.bookingSince ?? Date.now();
      if (Date.now() - since > BOOKING_TIMEOUT_MS) {
        await this.discoveries.finish(
          head.id,
          "Failed",
          "no server came free in time, try again",
        );
        await this.patch(job, { bookingSince: undefined });
        return this.delayUntilNext(job, 0);
      }
      if (job.data.bookingSince === undefined) {
        await this.patch(job, { bookingSince: since });
      }
      return this.delayUntilNext(job, SERVER_BUSY_RETRY_MS);
    }

    this.logger.log(`${tag} booked session ${session.id} on ${head.map_name}`);
    await this.patch(job, {
      sessionId: session.id,
      bookedAt: Date.now(),
      mapChangeAt: undefined,
      runAttempts: 0,
      bookingSince: undefined,
    });
    return this.delayUntilNext(job, CHECK_DELAY_MS);
  }

  private async changeMap(
    job: Job<JobData>,
    head: UtilityDiscoveryHead,
    sessionId: string,
  ) {
    try {
      await this.practice.changeRenderMap(sessionId, head.map_name);
    } catch (error) {
      this.logger.warn(
        `[utility-discovery ${head.id}] map change to ${head.map_name} failed: ${(error as Error)?.message}`,
      );
      await this.release(job);
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }
    await this.patch(job, { mapChangeAt: Date.now() });
    return this.delayUntilNext(job, CHECK_DELAY_MS);
  }

  // How long the server has been changing level, or null once it is up: the
  // plugin clears the flag when it comes back and asks for its session.
  private async mapChangingMs(matchId: string | null): Promise<number | null> {
    const render = matchId
      ? await this.practice.renderSessionForMatch(matchId)
      : null;
    return render?.map_changing_seconds == null
      ? null
      : render.map_changing_seconds * 1000;
  }

  private async run(
    job: Job<JobData>,
    head: UtilityDiscoveryHead,
    sessionId: string,
  ) {
    const tag = `[utility-discovery ${head.id}]`;
    const serverId = await this.practice.renderServerId(sessionId);

    if (!serverId) {
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    await this.discoveries.markVerifying(head.id, sessionId);

    if (await this.load.discovery(serverId, "run", head.id)) {
      this.logger.log(`${tag} sent to server ${serverId}`);
      await this.patch(job, { runAttempts: 0 });
      return this.delayUntilNext(job, POLL_DELAY_MS);
    }

    const attempts = (job.data.runAttempts ?? 0) + 1;

    if (attempts >= RUN_ATTEMPTS) {
      await this.discoveries.finish(
        head.id,
        "Failed",
        "the server would not take the discovery",
      );
      await this.release(job);
      return this.delayUntilNext(job, 0);
    }

    // Back in the queue so the next pass sends it again rather than reading
    // it as one the server is already throwing.
    await this.discoveries.requeue(head.id);
    await this.patch(job, { runAttempts: attempts });
    return this.delayUntilNext(job, CHECK_DELAY_MS);
  }

  private async onEmptyQueue(job: Job<JobData>): Promise<void> {
    if (!job.data.sessionId) {
      // Started between the read above and this job ending: its own add() was
      // dropped as a duplicate of this one.
      if (await this.discoveries.next()) {
        return this.delayUntilNext(job, 0);
      }
      return;
    }

    const idleSince = job.data.idleSince ?? Date.now();

    if (Date.now() - idleSince < WARM_MS) {
      if (job.data.idleSince === undefined) {
        await this.patch(job, { idleSince });
      }
      return this.delayUntilNext(job, CHECK_DELAY_MS);
    }

    await this.release(job);

    // A discovery started while this ran had its own add() dropped as a
    // duplicate of this job, which is about to stop existing.
    if (await this.discoveries.next()) {
      return this.delayUntilNext(job, 0);
    }
  }

  private async release(job: Job<JobData>): Promise<void> {
    if (job.data.sessionId) {
      try {
        await this.practice.endRenderSession(job.data.sessionId);
      } catch (error) {
        this.logger.warn(
          `[utility-discovery] releasing session ${job.data.sessionId} failed: ${(error as Error)?.message}`,
        );
      }
    }
    await job.updateData({});
  }

  private async patch(job: Job<JobData>, data: Partial<JobData>) {
    await job.updateData({ ...job.data, ...data });
  }

  private async delayUntilNext(job: Job, ms: number): Promise<void> {
    await job.moveToDelayed(Date.now() + ms, job.token);
    throw new DelayedError();
  }
}
