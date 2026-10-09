import { DelayedError } from "bullmq";
import { BatchUtilityRenderJob } from "./BatchUtilityRenderJob";
import {
  NadeRenderPodBusyError,
  NoGpuAvailableError,
  NoSteamAccountAvailableError,
} from "../../matches/game-streamer/game-streamer.service";

const RENDER = {
  id: "render-1",
  utility_lineup_id: "lineup-1",
  map_name: "de_mirage",
  session_token: "token-1",
  spec: { lineup_id: "lineup-1", map_name: "de_mirage" },
  status: "queued",
  k8s_job_name: null as string | null,
  utility_practice_session_id: null as string | null,
};

const POD = "gs-nades-queue";

// A row the pod has been handed: what it takes down with it if it dies.
const HANDED = {
  ...RENDER,
  k8s_job_name: POD,
  utility_practice_session_id: "session-1",
};

const makeJob = (
  data: Record<string, unknown>,
  id = "utility-render-queue",
) => {
  const job: any = {
    id,
    data,
    token: "bull-token",
    updateData: jest.fn(async (next: Record<string, unknown>) => {
      job.data = next;
    }),
    moveToDelayed: jest.fn(),
  };
  return job;
};

describe("BatchUtilityRenderJob", () => {
  let job: BatchUtilityRenderJob;
  let renders: Record<string, jest.Mock>;
  let practice: Record<string, jest.Mock>;
  let gameStreamer: Record<string, jest.Mock>;
  let matchAssistant: Record<string, jest.Mock>;
  let logger: Record<string, jest.Mock>;

  beforeEach(() => {
    // What is in flight, as the database would have it: a render that has
    // been failed is not.
    let queue: Array<typeof RENDER> = [RENDER];
    renders = {
      inFlight: jest.fn(async () => queue),
      attachSession: jest.fn(),
      attachJobName: jest.fn(),
      stampBootStage: jest.fn(),
      bootStatusForMatch: jest.fn().mockResolvedValue(null),
      noteBootProblem: jest.fn(),
      failRenders: jest.fn(async (ids: Array<string>) => {
        queue = queue.filter((render) => !ids.includes(render.id));
      }),
      requesterFor: jest.fn().mockResolvedValue("76561198000000002"),
      dispatch: jest.fn(),
    };
    practice = {
      startForRender: jest
        .fn()
        .mockResolvedValue({ id: "session-1", status: "Starting" }),
      session: jest
        .fn()
        .mockResolvedValue({ id: "session-1", status: "Ready" }),
      renderConnection: jest.fn().mockResolvedValue({
        addr: "1.2.3.4:27015",
        password: "pw",
        match_id: "match-1",
        plugin_runtime: "swiftlys2",
        node_id: "node-A",
      }),
      endRenderSession: jest.fn(),
      canPracticeOn: jest.fn().mockResolvedValue(true),
      markRenderPod: jest.fn(),
    };
    gameStreamer = {
      dispatchNadePreviews: jest
        .fn()
        .mockResolvedValue({ jobName: POD, nodeId: "node-A" }),
      getNadeRenderPodState: jest.fn().mockResolvedValue("running"),
      promotePendingLiveStreams: jest.fn().mockResolvedValue({ promoted: [] }),
      getNadeRenderPodFailureReason: jest.fn().mockResolvedValue(null),
      freeRenderGpuNodeIds: jest.fn().mockResolvedValue(["node-A"]),
      killNadeRenderPod: jest.fn(),
    };
    matchAssistant = {
      getMatchServerLogTail: jest.fn().mockResolvedValue(null),
    };
    logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    job = new BatchUtilityRenderJob(
      logger as any,
      renders as any,
      practice as any,
      gameStreamer as any,
      matchAssistant as any,
    );
  });

  // The server boot is the queue's blind spot: these are what turned "queued
  // for ten minutes" into a readable stall.
  it("mirrors the server's boot status into the stepper while waiting", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Starting",
      match_id: "match-1",
    });
    renders.bootStatusForMatch.mockResolvedValueOnce({
      boot_status: "WaitingForPing",
      boot_status_detail: "Server pod is running.",
    });

    await expect(
      job.process(
        makeJob({
          mapName: "de_mirage",
          sessionId: "session-1",
          bookedAt: Date.now(),
        }) as any,
      ),
    ).rejects.toThrow();

    expect(renders.stampBootStage).toHaveBeenCalledWith(
      [RENDER.id],
      "server_starting:WaitingForPing",
    );
  });

  it("names the GPU refusal on the stepper instead of retrying invisibly", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Ready",
      match_id: "match-1",
    });
    gameStreamer.dispatchNadePreviews.mockRejectedValueOnce(
      new NoGpuAvailableError(),
    );

    await expect(
      job.process(
        makeJob({
          mapName: "de_mirage",
          sessionId: "session-1",
          bookedAt: Date.now(),
        }) as any,
      ),
    ).rejects.toThrow();

    expect(renders.stampBootStage).toHaveBeenCalledWith(
      [RENDER.id],
      "dispatching_pod:NoGpuAvailable",
    );
    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("surfaces the pod's log on the queued rows two minutes into a silent boot", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Starting",
      match_id: "match-1",
    });
    renders.bootStatusForMatch.mockResolvedValueOnce({
      boot_status: "WaitingForPing",
      boot_status_detail: "Server pod is running.",
    });
    matchAssistant.getMatchServerLogTail.mockResolvedValueOnce(
      "steamclient.so: cannot open shared object file",
    );

    await expect(
      job.process(
        makeJob({
          mapName: "de_mirage",
          sessionId: "session-1",
          bookedAt: Date.now() - 3 * 60 * 1000,
        }) as any,
      ),
    ).rejects.toThrow();

    expect(renders.noteBootProblem).toHaveBeenCalledWith(
      [RENDER.id],
      "practice server pod is up but silent — steamclient.so: cannot open shared object file",
    );
    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("puts the pod's log tail on the ready-timeout failure", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Starting",
      match_id: "match-1",
    });
    matchAssistant.getMatchServerLogTail.mockResolvedValueOnce(
      "swiftlys2: unable to load gamedata",
    );

    await job.process(
      makeJob({
        mapName: "de_mirage",
        sessionId: "session-1",
        bookedAt: Date.now() - 11 * 60 * 1000,
      }) as any,
    );

    expect(matchAssistant.getMatchServerLogTail).toHaveBeenCalledWith(
      "match-1",
    );
    expect(renders.failRenders).toHaveBeenCalledWith(
      [RENDER.id],
      "practice server did not become ready in time — swiftlys2: unable to load gamedata",
    );
  });

  it("still fails plainly when no pod log can be read", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Starting",
      match_id: "match-1",
    });

    await job.process(
      makeJob({
        mapName: "de_mirage",
        sessionId: "session-1",
        bookedAt: Date.now() - 11 * 60 * 1000,
      }) as any,
    );

    expect(renders.failRenders).toHaveBeenCalledWith(
      [RENDER.id],
      "practice server did not become ready in time",
    );
  });

  it("exits without booking anything when the queue is empty", async () => {
    renders.inFlight.mockResolvedValue([]);

    await job.process(makeJob({}) as any);

    expect(practice.startForRender).not.toHaveBeenCalled();
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  it("books one practice session for the map and attaches the batch to it", async () => {
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.startForRender).toHaveBeenCalledWith({
      mapName: "de_mirage",
      requestedBySteamId: "76561198000000002",
    });
    expect(renders.attachSession).toHaveBeenCalledWith(
      ["render-1"],
      "session-1",
    );
    expect(bull.data.sessionId).toBe("session-1");
    expect(bull.data.mapName).toBe("de_mirage");
  });

  // One server films the whole queue. It is booked on the map at the head of
  // it, and the pod moves it on to the others when it gets to them.
  it("books the map at the head of the queue and leaves the rest waiting on it", async () => {
    const inferno = { ...RENDER, id: "render-inferno", map_name: "de_inferno" };
    renders.inFlight.mockResolvedValue([RENDER, inferno]);
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.startForRender).toHaveBeenCalledTimes(1);
    expect(practice.startForRender).toHaveBeenCalledWith(
      expect.objectContaining({ mapName: "de_mirage" }),
    );
    expect(renders.attachSession).toHaveBeenCalledWith(
      ["render-1"],
      "session-1",
    );
    expect(renders.stampBootStage).toHaveBeenCalledWith(
      ["render-inferno"],
      "waiting_for_map",
    );
  });

  it("starts the pod with the booked map's rows and nobody else's", async () => {
    const inferno = { ...RENDER, id: "render-inferno", map_name: "de_inferno" };
    const taken = {
      ...HANDED,
      id: "render-taken",
      utility_practice_session_id: "session-0",
    };
    renders.inFlight.mockResolvedValue([RENDER, taken, inferno]);
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    const jobs = gameStreamer.dispatchNadePreviews.mock.calls[0][3];
    expect(jobs.map((entry: { job_id: string }) => entry.job_id)).toEqual([
      "render-1",
    ]);
    expect(renders.attachJobName).toHaveBeenCalledWith(
      ["render-1"],
      POD,
      "node-A",
    );
    expect(bull.data.jobName).toBe(POD);
  });

  // A map disabled or deleted since its lineups were recorded. Retried like
  // "no server free yet" it held the head of the queue for good, with every
  // other map stuck behind it.
  it("fails a map no server can be booked on and carries on with the rest", async () => {
    const inferno = { ...RENDER, id: "render-inferno", map_name: "de_inferno" };
    let queue = [RENDER, inferno];
    renders.inFlight.mockImplementation(async () => queue);
    renders.failRenders.mockImplementation(async (ids: Array<string>) => {
      queue = queue.filter((render) => !ids.includes(render.id));
    });
    practice.canPracticeOn.mockImplementation(
      async (mapName: string) => mapName !== "de_mirage",
    );
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      expect.stringContaining("not available for practice"),
    );
    expect(practice.startForRender).not.toHaveBeenCalled();

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.startForRender).toHaveBeenCalledWith(
      expect.objectContaining({ mapName: "de_inferno" }),
    );
  });

  // The list a pod starts with travels in one environment variable, and the
  // kernel refuses a string over 128KiB: a map's whole queue of recorded
  // run-ups failed every row on it without filming one.
  describe("what a pod is started with", () => {
    const entry = (id: number, bytes: number) => ({
      job_id: `render-${id}`,
      spec: { approach: "x".repeat(bytes) },
    });

    it("is the front of the queue, as much as fits", () => {
      const jobs = Array.from({ length: 10 }, (_, id) => entry(id, 20_000));

      const first = BatchUtilityRenderJob.firstBatch(jobs);

      expect(first).toEqual(jobs.slice(0, first.length));
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThan(jobs.length);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(128 * 1024);
    });

    it("is never more than a pod that dies booting should take with it", () => {
      const jobs = Array.from({ length: 200 }, (_, id) => entry(id, 10));

      expect(BatchUtilityRenderJob.firstBatch(jobs).length).toBe(12);
    });

    it("is still one lineup when that one is too big on its own", () => {
      expect(
        BatchUtilityRenderJob.firstBatch([entry(1, 200_000), entry(2, 10)]),
      ).toHaveLength(1);
    });

    it("leaves the rest of the map for the pod to ask for", async () => {
      const rows = Array.from({ length: 20 }, (_, id) => ({
        ...RENDER,
        id: `render-${id}`,
      }));
      renders.inFlight.mockResolvedValue(rows);
      const bull = makeJob({
        mapName: "de_mirage",
        sessionId: "session-1",
        bookedAt: Date.now(),
      });

      await expect(job.process(bull as any)).rejects.toBeInstanceOf(
        DelayedError,
      );

      const sent = gameStreamer.dispatchNadePreviews.mock.calls[0][3];
      expect(sent).toHaveLength(12);
      // All twenty are on the session, so the plugin knows each when the pod
      // is handed it; only the twelve are the pod's so far.
      expect(renders.attachSession.mock.calls.at(-1)[0]).toHaveLength(20);
      expect(renders.attachJobName.mock.calls[0][0]).toEqual(
        rows.slice(0, 12).map((row) => row.id),
      );
    });
  });

  // Its rows carry its name and its GPU is held on the session, so both have
  // to be written down for the pod that was actually started.
  it("records the pod on the session it is filming on", async () => {
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.markRenderPod).toHaveBeenCalledWith("session-1", POD);
  });

  // The api stopped between starting the pod and writing that down. Read as
  // "another pod has everything" the job ended its own pod's session.
  it("takes back a pod it started and never got to record", async () => {
    renders.inFlight.mockResolvedValue([HANDED]);
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(bull.data).toMatchObject({ dispatched: true, jobName: POD });
    // Without this the pod is told there is nothing for it the first time it
    // asks: the session does not know it has one.
    expect(practice.markRenderPod).toHaveBeenCalledWith("session-1", POD);
    expect(practice.endRenderSession).not.toHaveBeenCalled();
    expect(gameStreamer.dispatchNadePreviews).not.toHaveBeenCalled();
  });

  // Booked when every map had a job of its own. Left running as a second
  // queue worker it booked a second server for the same rows.
  it("hands what is left to the queue's one job once a per-map job holds nothing", async () => {
    const bull = makeJob({ mapName: "de_mirage" }, "utility-render-batch-de_mirage");

    await job.process(bull as any);

    expect(renders.dispatch).toHaveBeenCalledTimes(1);
    expect(practice.startForRender).not.toHaveBeenCalled();
    expect(bull.moveToDelayed).not.toHaveBeenCalled();
  });

  it("lets a per-map job finish the batch it is still holding", async () => {
    const bull = makeJob(
      {
        mapName: "de_mirage",
        sessionId: "session-1",
        dispatched: true,
        dispatchedIds: ["render-1"],
      },
      "utility-render-batch-de_mirage",
    );

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.dispatch).not.toHaveBeenCalled();
  });

  // Normally the job that started a pod watches it and fails what it leaves.
  // A row is only left like this when that job was lost, and left alone it is
  // in flight forever: nothing films it and its lineup cannot be queued again.
  it("fails a render still held by a pod that no longer exists", async () => {
    const orphan = { ...HANDED, utility_practice_session_id: "session-0" };
    renders.inFlight
      .mockResolvedValueOnce([orphan])
      .mockResolvedValueOnce([]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("absent");
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "render pod no longer present (Job deleted)",
    );
    expect(practice.startForRender).not.toHaveBeenCalled();
  });

  // Booked before the queue shared a pod, and still filming. A second server
  // for rows that pod already has would have nothing to film.
  it("books nothing while another pod that is still up has everything in flight", async () => {
    renders.inFlight.mockResolvedValue([HANDED]);
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.startForRender).not.toHaveBeenCalled();
    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("books for what nobody has and leaves another pod's rows to it", async () => {
    const inferno = { ...RENDER, id: "render-inferno", map_name: "de_inferno" };
    renders.inFlight.mockResolvedValue([HANDED, inferno]);
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.startForRender).toHaveBeenCalledWith(
      expect.objectContaining({ mapName: "de_inferno" }),
    );
    expect(renders.attachSession).toHaveBeenCalledWith(
      ["render-inferno"],
      "session-1",
    );
  });

  it("books again when everything on the booked map was cancelled before the pod started", async () => {
    const inferno = { ...RENDER, id: "render-inferno", map_name: "de_inferno" };
    renders.inFlight.mockResolvedValue([inferno]);
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(gameStreamer.dispatchNadePreviews).not.toHaveBeenCalled();
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
    expect(renders.failRenders).not.toHaveBeenCalled();
    expect(bull.data.sessionId).toBeUndefined();
  });

  it("books nothing while no GPU is free to film on", async () => {
    gameStreamer.freeRenderGpuNodeIds.mockResolvedValueOnce([]);
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.startForRender).not.toHaveBeenCalled();
    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("gives up on a GPU that stays busy and frees the practice server", async () => {
    gameStreamer.dispatchNadePreviews.mockRejectedValueOnce(
      new NoGpuAvailableError(),
    );
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
      gpuWaitSince: Date.now() - 11 * 60 * 1000,
    });

    await job.process(bull as any);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      expect.stringContaining("never came free"),
    );
    expect(practice.endRenderSession).toHaveBeenCalled();
  });

  it("retries instead of failing when no practice server is free", async () => {
    practice.startForRender.mockRejectedValueOnce(
      new Error("no server available"),
    );
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).not.toHaveBeenCalled();
    expect(bull.moveToDelayed).toHaveBeenCalled();
  });

  it("waits for the server to be Ready before spending a GPU", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Starting",
    });
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(gameStreamer.dispatchNadePreviews).not.toHaveBeenCalled();
  });

  it("puts a lineup approved while the server booted on the session before filming it", async () => {
    const late = {
      ...RENDER,
      id: "render-late",
      utility_lineup_id: "lineup-2",
    };
    renders.inFlight.mockResolvedValue([RENDER, late]);
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.attachSession).toHaveBeenCalledWith(
      ["render-1", "render-late"],
      "session-1",
    );
    expect(renders.attachSession.mock.invocationCallOrder[0]).toBeLessThan(
      gameStreamer.dispatchNadePreviews.mock.invocationCallOrder[0],
    );
  });

  it("stamps the server's plugin runtime onto every spec at dispatch", async () => {
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    const [mapName, matchId, connect, jobs] =
      gameStreamer.dispatchNadePreviews.mock.calls[0];
    expect(mapName).toBe("de_mirage");
    expect(matchId).toBe("match-1");
    expect(connect).toEqual({
      addr: "1.2.3.4:27015",
      password: "pw",
      nodeId: "node-A",
    });
    expect(jobs).toEqual([
      {
        job_id: "render-1",
        session_token: "token-1",
        spec: {
          lineup_id: "lineup-1",
          map_name: "de_mirage",
          plugin_runtime: "swiftlys2",
        },
      },
    ]);
    expect(renders.attachJobName).toHaveBeenCalledWith(
      ["render-1"],
      POD,
      "node-A",
    );
    expect(bull.data.dispatched).toBe(true);
  });

  it("holds the batch rather than failing it when the GPU pool is busy", async () => {
    gameStreamer.dispatchNadePreviews.mockRejectedValueOnce(
      new NoGpuAvailableError(),
    );
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).not.toHaveBeenCalled();
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  it("holds the batch when the Steam pool is empty", async () => {
    gameStreamer.dispatchNadePreviews.mockRejectedValueOnce(
      new NoSteamAccountAvailableError(),
    );
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("fails the batch and hands the server back when dispatch really fails", async () => {
    gameStreamer.dispatchNadePreviews.mockRejectedValueOnce(
      new Error("k8s said no"),
    );
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await job.process(bull as any);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "dispatch failed: k8s said no",
    );
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  it("gives up on a server that never becomes ready", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Starting",
    });
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now() - 60 * 60 * 1000,
    });

    await job.process(bull as any);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "practice server did not become ready in time",
    );
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  it("keeps polling while the pod is alive", async () => {
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("fails whatever the pod left in flight, with the pod's own reason", async () => {
    renders.inFlight.mockResolvedValueOnce([HANDED]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("failed");
    gameStreamer.getNadeRenderPodFailureReason.mockResolvedValueOnce(
      "Error — exit=1 — [nade] ERROR: capture failed to start",
    );
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await job.process(bull as any);

    expect(gameStreamer.getNadeRenderPodState).toHaveBeenCalledWith(POD);
    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "Error — exit=1 — [nade] ERROR: capture failed to start",
    );
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  // A dead pod takes down what it was handed and nothing else: a row queued
  // behind it, on this map or another, was never attempted.
  it("leaves a render the pod never had out of the pod's failure", async () => {
    const late = { ...RENDER, id: "render-2", utility_lineup_id: "lineup-2" };
    const inferno = { ...RENDER, id: "render-inferno", map_name: "de_inferno" };
    renders.inFlight.mockResolvedValueOnce([HANDED, late, inferno]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("succeeded");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).toHaveBeenCalledTimes(1);
    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "render pod exited before reporting terminal status",
    );
  });

  it("does not blame this pod for a row another session's pod was handed", async () => {
    const elsewhere = { ...HANDED, utility_practice_session_id: "session-0" };
    renders.inFlight.mockResolvedValueOnce([elsewhere]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("absent");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  // Booked before rows carried their pod's name: the batch knew its rows by a
  // list and its pod by its map.
  it("still winds down a batch booked before the queue shared one pod", async () => {
    const late = { ...RENDER, id: "render-2", utility_lineup_id: "lineup-2" };
    renders.inFlight.mockResolvedValueOnce([RENDER, late]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("succeeded");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      dispatchedIds: ["render-1"],
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(gameStreamer.getNadeRenderPodState).toHaveBeenCalledWith(
      "gs-nades-demirage",
    );
    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "render pod exited before reporting terminal status",
    );
  });

  it("fails what a pod from before the queue shared one pulled for itself, too", async () => {
    const pulled = {
      ...RENDER,
      id: "render-pulled",
      k8s_job_name: "gs-nades-demirage",
      utility_practice_session_id: "session-1",
    };
    renders.inFlight.mockResolvedValueOnce([RENDER, pulled]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("failed");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      dispatchedIds: ["render-1"],
    });

    await job.process(bull as any);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1", "render-pulled"],
      "render pod failed (k8s reported Job in failed state)",
    );
  });

  // A cancel kills the pod, and the retry is queued while this job is still
  // winding the old batch down -- its own add() was dropped as a duplicate of
  // this very job, so nothing else is coming for it for up to five minutes.
  it("goes straight on to a render queued behind the batch it lost", async () => {
    const retry = { ...RENDER, id: "render-2" };
    renders.inFlight.mockResolvedValueOnce([retry]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("absent");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
    expect(bull.updateData).toHaveBeenLastCalledWith({});
    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("holds the batch when a pod for the map is still terminating", async () => {
    gameStreamer.dispatchNadePreviews.mockRejectedValueOnce(
      new NadeRenderPodBusyError(),
    );
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      bookedAt: Date.now(),
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).not.toHaveBeenCalled();
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  // This is the only job. Returning with other maps still queued left them
  // with nothing coming until the five-minute reconcile.
  it("goes on to the other maps when one map's rows cannot be booked", async () => {
    const inferno = { ...RENDER, id: "render-inferno", map_name: "de_inferno" };
    let queue = [RENDER, inferno];
    renders.inFlight.mockImplementation(async () => queue);
    renders.failRenders.mockImplementation(async (ids: Array<string>) => {
      queue = queue.filter((render) => !ids.includes(render.id));
    });
    renders.requesterFor.mockResolvedValueOnce(null);
    const bull = makeJob({});

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "render has no requester to host its practice session",
    );
  });

  // The pod is stopped early when a stream is waiting for its GPU, and this is
  // the call that gives the stream the GPU.
  it("offers the GPU to a waiting live stream when it lets the server go", async () => {
    renders.inFlight.mockResolvedValue([]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("succeeded");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await job.process(bull as any);

    expect(gameStreamer.promotePendingLiveStreams).toHaveBeenCalledTimes(1);
  });

  it("has no GPU to offer when no pod was ever started", async () => {
    renders.inFlight.mockResolvedValue([]);
    const bull = makeJob({ mapName: "de_mirage", sessionId: "session-1" });

    await job.process(bull as any);

    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
    expect(gameStreamer.promotePendingLiveStreams).not.toHaveBeenCalled();
  });

  it("fails a render that has no requester instead of retrying forever", async () => {
    renders.requesterFor.mockResolvedValueOnce(null);
    const bull = makeJob({});

    await job.process(bull as any);

    expect(practice.startForRender).not.toHaveBeenCalled();
    expect(bull.moveToDelayed).not.toHaveBeenCalled();
    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "render has no requester to host its practice session",
    );
  });

  it("releases the practice server once the queue drains and the pod has stopped", async () => {
    renders.inFlight.mockResolvedValue([]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("succeeded");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await job.process(bull as any);

    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
    expect(gameStreamer.killNadeRenderPod).not.toHaveBeenCalled();
  });

  // Its own add() was dropped as a duplicate of this job, which is about to
  // stop existing.
  it("goes round again for a render approved while it was shutting down", async () => {
    renders.inFlight.mockResolvedValueOnce([]).mockResolvedValueOnce([RENDER]);
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("succeeded");
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  // The pod waits a moment for the next render before it stops. Ending its
  // session the instant the queue empties is the boot it was waiting to save.
  it("keeps the server while a pod with nothing to film waits for more", async () => {
    renders.inFlight.mockResolvedValueOnce([]);
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.endRenderSession).not.toHaveBeenCalled();
    expect(gameStreamer.killNadeRenderPod).not.toHaveBeenCalled();
    expect(typeof bull.data.idleSince).toBe("number");
  });

  it("stops a pod that is still up long after the queue emptied", async () => {
    renders.inFlight.mockResolvedValue([]);
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
      idleSince: Date.now() - 6 * 60 * 1000,
    });

    await job.process(bull as any);

    expect(gameStreamer.killNadeRenderPod).toHaveBeenCalledWith(POD);
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  it("starts the idle clock over once there is something to film again", async () => {
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
      jobName: POD,
      idleSince: Date.now() - 6 * 60 * 1000,
    });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(bull.data.idleSince).toBeUndefined();
    expect(gameStreamer.killNadeRenderPod).not.toHaveBeenCalled();
  });
});
