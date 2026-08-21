import { DelayedError } from "bullmq";
import { BatchUtilityRenderJob } from "./BatchUtilityRenderJob";
import {
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
};

const makeJob = (data: Record<string, unknown>) => {
  const job: any = {
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
  let logger: Record<string, jest.Mock>;

  beforeEach(() => {
    renders = {
      inFlightForMap: jest.fn().mockResolvedValue([RENDER]),
      attachSession: jest.fn(),
      attachJobName: jest.fn(),
      failRenders: jest.fn(),
      requesterFor: jest.fn().mockResolvedValue("76561198000000002"),
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
      }),
      endRenderSession: jest.fn(),
    };
    gameStreamer = {
      dispatchNadePreviews: jest
        .fn()
        .mockResolvedValue({ jobName: "gs-nades-demirage", nodeId: "node-A" }),
      getNadeRenderPodState: jest.fn().mockResolvedValue("running"),
      getNadeRenderPodFailureReason: jest.fn().mockResolvedValue(null),
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
    );
  });

  it("exits without booking anything when the map's queue is empty", async () => {
    renders.inFlightForMap.mockResolvedValueOnce([]);

    await job.process(makeJob({ mapName: "de_mirage" }) as any);

    expect(practice.startForRender).not.toHaveBeenCalled();
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  it("books one practice session for the map and attaches the batch to it", async () => {
    const bull = makeJob({ mapName: "de_mirage" });

    await expect(job.process(bull as any)).rejects.toBeInstanceOf(DelayedError);

    expect(practice.startForRender).toHaveBeenCalledWith({
      mapName: "de_mirage",
      hostSteamId: "76561198000000002",
    });
    expect(renders.attachSession).toHaveBeenCalledWith(
      ["render-1"],
      "session-1",
    );
    expect(bull.data.sessionId).toBe("session-1");
  });

  it("retries instead of failing when no practice server is free", async () => {
    practice.startForRender.mockRejectedValueOnce(
      new Error("no server available"),
    );
    const bull = makeJob({ mapName: "de_mirage" });

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
    expect(connect).toEqual({ addr: "1.2.3.4:27015", password: "pw" });
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
      "gs-nades-demirage",
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
    gameStreamer.getNadeRenderPodState.mockResolvedValueOnce("failed");
    gameStreamer.getNadeRenderPodFailureReason.mockResolvedValueOnce(
      "Error — exit=1 — [nade] ERROR: capture failed to start",
    );
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
    });

    await job.process(bull as any);

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-1"],
      "Error — exit=1 — [nade] ERROR: capture failed to start",
    );
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  it("releases the practice server once the queue drains", async () => {
    renders.inFlightForMap.mockResolvedValueOnce([]);
    const bull = makeJob({
      mapName: "de_mirage",
      sessionId: "session-1",
      dispatched: true,
    });

    await job.process(bull as any);

    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });
});
