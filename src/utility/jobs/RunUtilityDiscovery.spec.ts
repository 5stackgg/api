import { DelayedError } from "bullmq";
import { RunUtilityDiscovery } from "./RunUtilityDiscovery";

const HEAD = {
  id: "discovery-1",
  map_name: "de_mirage",
  status: "Queued",
  requested_by_steam_id: "76561198000000002",
  utility_practice_session_id: null as string | null,
  created_at: new Date(),
  started_at: null as Date | null,
};

const makeJob = (data: Record<string, unknown>) => {
  const job: any = {
    id: "utility-discovery-queue",
    data,
    token: "bull-token",
    updateData: jest.fn(async (next: Record<string, unknown>) => {
      job.data = next;
    }),
    moveToDelayed: jest.fn(),
  };
  return job;
};

describe("RunUtilityDiscovery", () => {
  let job: RunUtilityDiscovery;
  let discoveries: Record<string, jest.Mock>;
  let practice: Record<string, jest.Mock>;
  let load: Record<string, jest.Mock>;
  let head: typeof HEAD | null;

  beforeEach(() => {
    head = { ...HEAD, created_at: new Date() };
    discoveries = {
      next: jest.fn(async () => head),
      finish: jest.fn(async () => {
        head = null;
      }),
      markVerifying: jest.fn(async (_id: string, sessionId: string) => {
        head = {
          ...head!,
          status: "Verifying",
          utility_practice_session_id: sessionId,
          started_at: new Date(),
        };
      }),
      requeue: jest.fn(async () => {
        head = {
          ...head!,
          status: "Queued",
          utility_practice_session_id: null,
          started_at: null,
        };
      }),
    };
    practice = {
      canPracticeOn: jest.fn().mockResolvedValue(true),
      startForRender: jest
        .fn()
        .mockResolvedValue({ id: "session-1", status: "Starting" }),
      session: jest.fn().mockResolvedValue({
        id: "session-1",
        status: "Ready",
        map_name: "de_mirage",
        match_id: "match-1",
      }),
      renderSessionForMatch: jest
        .fn()
        .mockResolvedValue({ map_changing_seconds: null }),
      changeRenderMap: jest.fn().mockResolvedValue("de_inferno"),
      renderServerId: jest.fn().mockResolvedValue("server-1"),
      endRenderSession: jest.fn(),
    };
    load = {
      discovery: jest.fn().mockResolvedValue(true),
    };

    job = new RunUtilityDiscovery(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      discoveries as any,
      practice as any,
      load as any,
    );
  });

  const step = async (bullJob: any) => {
    await expect(job.process(bullJob)).rejects.toBeInstanceOf(DelayedError);
  };

  it("books a discovery server with no GPU for the head of the queue", async () => {
    const bullJob = makeJob({});

    await step(bullJob);

    expect(practice.startForRender).toHaveBeenCalledWith({
      mapName: "de_mirage",
      requestedBySteamId: HEAD.requested_by_steam_id,
      isDiscovery: true,
    });
    expect(bullJob.data.sessionId).toBe("session-1");
  });

  it("sends a queued discovery once the server is up on its map", async () => {
    const bullJob = makeJob({ sessionId: "session-1", bookedAt: Date.now() });

    await step(bullJob);

    expect(discoveries.markVerifying).toHaveBeenCalledWith(
      "discovery-1",
      "session-1",
    );
    expect(load.discovery).toHaveBeenCalledWith(
      "server-1",
      "run",
      "discovery-1",
    );
    expect(head!.status).toBe("Verifying");
  });

  it("waits for a server that is still booting", async () => {
    practice.session.mockResolvedValueOnce({
      id: "session-1",
      status: "Starting",
      map_name: "de_mirage",
    });

    await step(makeJob({ sessionId: "session-1", bookedAt: Date.now() }));

    expect(load.discovery).not.toHaveBeenCalled();
    expect(discoveries.finish).not.toHaveBeenCalled();
  });

  it("moves a warm server to the next discovery's map", async () => {
    head = { ...head!, map_name: "de_inferno" };
    const bullJob = makeJob({ sessionId: "session-1", bookedAt: Date.now() });

    await step(bullJob);

    expect(practice.changeRenderMap).toHaveBeenCalledWith(
      "session-1",
      "de_inferno",
    );
    expect(load.discovery).not.toHaveBeenCalled();
  });

  it("does not send while the level is still loading", async () => {
    practice.renderSessionForMatch.mockResolvedValueOnce({
      map_changing_seconds: 20,
    });

    await step(makeJob({ sessionId: "session-1", bookedAt: Date.now() }));

    expect(load.discovery).not.toHaveBeenCalled();
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  it("puts a run the server would not take back, and fails it after three", async () => {
    load.discovery.mockResolvedValue(false);
    const bullJob = makeJob({ sessionId: "session-1", bookedAt: Date.now() });

    await step(bullJob);
    expect(discoveries.requeue).toHaveBeenCalledTimes(1);
    expect(head!.status).toBe("Queued");

    await step(bullJob);
    await step(bullJob);

    expect(discoveries.finish).toHaveBeenCalledWith(
      "discovery-1",
      "Failed",
      "the server would not take the discovery",
    );
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
  });

  it("fails a discovery the server never finishes and stops the server throwing it", async () => {
    head = {
      ...head!,
      status: "Verifying",
      utility_practice_session_id: "session-1",
      started_at: new Date(Date.now() - 60 * 60 * 1000),
    };

    await step(makeJob({ sessionId: "session-1", bookedAt: Date.now() }));

    expect(load.discovery).toHaveBeenCalledWith(
      "server-1",
      "cancel",
      "discovery-1",
    );
    expect(discoveries.finish).toHaveBeenCalledWith(
      "discovery-1",
      "Failed",
      "the server did not finish in time",
    );
  });

  it("fails a discovery whose server this job no longer holds", async () => {
    head = {
      ...head!,
      status: "Verifying",
      utility_practice_session_id: "session-0",
      started_at: new Date(),
    };

    await step(makeJob({}));

    expect(discoveries.finish).toHaveBeenCalledWith(
      "discovery-1",
      "Failed",
      "the server throwing it was lost",
    );
    expect(load.discovery).toHaveBeenCalledWith(
      "server-1",
      "cancel",
      "discovery-1",
    );
    expect(practice.endRenderSession).toHaveBeenCalledWith("session-0");
    expect(practice.startForRender).not.toHaveBeenCalled();
  });

  it("gives up on a discovery after twenty minutes of failing to book", async () => {
    practice.startForRender.mockRejectedValue(new Error("no server free"));
    const bullJob = makeJob({});

    await step(bullJob);
    expect(discoveries.finish).not.toHaveBeenCalled();
    expect(bullJob.data.bookingSince).toBeDefined();

    bullJob.data.bookingSince = Date.now() - 30 * 60 * 1000;
    await step(bullJob);

    expect(discoveries.finish).toHaveBeenCalledWith(
      "discovery-1",
      "Failed",
      "no server came free in time, try again",
    );
  });

  it("waits its turn behind a working server however long the queue is", async () => {
    head = { ...head!, created_at: new Date(Date.now() - 60 * 60 * 1000) };

    await step(makeJob({ sessionId: "session-1", bookedAt: Date.now() }));

    expect(discoveries.finish).not.toHaveBeenCalled();
    expect(load.discovery).toHaveBeenCalledWith(
      "server-1",
      "run",
      "discovery-1",
    );
  });

  it("keeps its server through an error and tries again", async () => {
    discoveries.next.mockRejectedValueOnce(new Error("connection reset"));
    const bullJob = makeJob({ sessionId: "session-1", bookedAt: Date.now() });

    await step(bullJob);

    expect(bullJob.data.sessionId).toBe("session-1");
    expect(practice.endRenderSession).not.toHaveBeenCalled();
  });

  it("keeps an idle server warm, then releases it", async () => {
    head = null;
    const bullJob = makeJob({ sessionId: "session-1", bookedAt: Date.now() });

    await step(bullJob);
    expect(practice.endRenderSession).not.toHaveBeenCalled();
    expect(bullJob.data.idleSince).toBeDefined();

    bullJob.data.idleSince = Date.now() - 10 * 60 * 1000;
    await expect(job.process(bullJob)).resolves.toBeUndefined();

    expect(practice.endRenderSession).toHaveBeenCalledWith("session-1");
    expect(bullJob.data).toEqual({});
  });

  it("finishes straight away with nothing queued and no server", async () => {
    head = null;

    await expect(job.process(makeJob({}))).resolves.toBeUndefined();

    expect(practice.startForRender).not.toHaveBeenCalled();
  });
});
