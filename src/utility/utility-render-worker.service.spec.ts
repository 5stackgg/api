import { UtilityRenderWorkerService } from "./utility-render-worker.service";

const SESSION = {
  id: "session-1",
  match_id: "match-1",
  map_name: "de_mirage",
  status: "Ready",
  render_job_name: "gs-nades-queue" as string | null,
  map_changing_seconds: null as number | null,
};

const HANDED = {
  id: "render-1",
  utility_lineup_id: "lineup-1",
  map_name: "de_mirage",
  session_token: "token-1",
  spec: { lineup_id: "lineup-1", map_name: "de_mirage" },
  status: "queued",
  k8s_job_name: "gs-nades-queue",
  utility_practice_session_id: "session-1",
};

// The pod asks this between lineups. Before it existed a pod filmed the list
// it was booked with and stopped, so a render approved a second too late paid
// for a server and a cs2 boot of its own -- as did every map after the first.
describe("UtilityRenderWorkerService.next", () => {
  let service: UtilityRenderWorkerService;
  let postgres: { query: jest.Mock };
  let cache: Record<string, jest.Mock>;
  let renders: Record<string, jest.Mock>;
  let practice: Record<string, jest.Mock>;
  let logger: Record<string, jest.Mock>;
  let queued: Array<{ id: string; map_name: string }>;
  let liveStreamWaiting: boolean;

  beforeEach(() => {
    queued = [];
    liveStreamWaiting = false;
    postgres = {
      query: jest.fn(async (sql: string) =>
        sql.includes("match_streams")
          ? [{ waiting: liveStreamWaiting }]
          : queued,
      ),
    };
    const store = new Map<string, unknown>();
    cache = {
      has: jest.fn(async (key: string) => store.has(key)),
      get: jest.fn(async (key: string) => store.get(key)),
      put: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      forget: jest.fn(async (key: string) => {
        store.delete(key);
      }),
    };
    renders = {
      attachSession: jest.fn(),
      handToPod: jest.fn().mockResolvedValue(HANDED),
      stampBootStage: jest.fn(),
      failRenders: jest.fn(),
      strandedOnPod: jest.fn().mockResolvedValue([]),
      releaseFromPod: jest.fn(),
    };
    practice = {
      renderSessionForMatch: jest.fn().mockResolvedValue(SESSION),
      renderConnection: jest.fn().mockResolvedValue({
        addr: "127.0.0.1:27015",
        password: "pw",
        match_id: "match-1",
        plugin_runtime: "swiftlys2",
        node_id: "node-A",
      }),
      changeRenderMap: jest.fn().mockResolvedValue("de_inferno"),
      touchRenderPod: jest.fn(),
      canPracticeOn: jest.fn().mockResolvedValue(true),
    };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new UtilityRenderWorkerService(
      logger as any,
      postgres as any,
      cache as any,
      renders as any,
      practice as any,
    );
  });

  it("hands over the next lineup on the map the server is already on", async () => {
    queued = [
      { id: "render-1", map_name: "de_mirage" },
      { id: "render-2", map_name: "de_mirage" },
      { id: "render-3", map_name: "de_inferno" },
    ];

    const next = await service.next("match-1");

    expect(next).toEqual({
      action: "render",
      jobs: [
        {
          job_id: "render-1",
          token: "token-1",
          spec: {
            lineup_id: "lineup-1",
            map_name: "de_mirage",
            plugin_runtime: "swiftlys2",
          },
        },
      ],
    });
    expect(renders.handToPod).toHaveBeenCalledWith("render-1", {
      sessionId: "session-1",
      jobName: "gs-nades-queue",
      nodeId: "node-A",
    });
    expect(practice.changeRenderMap).not.toHaveBeenCalled();
  });

  // The plugin only knows the lineups on its session; it re-reads them each
  // time the pod stages one.
  it("puts the map's whole queue on the session", async () => {
    queued = [
      { id: "render-1", map_name: "de_mirage" },
      { id: "render-2", map_name: "de_mirage" },
    ];

    await service.next("match-1");

    expect(renders.attachSession).toHaveBeenCalledWith(
      ["render-1", "render-2"],
      "session-1",
    );
    // Said once per row, not once per lineup filmed ahead of it.
    expect(renders.stampBootStage).toHaveBeenCalledWith(
      ["render-2"],
      "waiting_turn",
      null,
      { once: true },
    );
  });

  it("asks again rather than film a lineup somebody else just took", async () => {
    queued = [{ id: "render-1", map_name: "de_mirage" }];
    renders.handToPod.mockResolvedValueOnce(null);

    await expect(service.next("match-1")).resolves.toEqual({
      action: "wait",
      seconds: 1,
    });
  });

  it("moves the server on when this map is done and another is queued", async () => {
    queued = [
      { id: "render-3", map_name: "de_inferno" },
      { id: "render-4", map_name: "de_nuke" },
      { id: "render-5", map_name: "de_inferno" },
    ];

    await expect(service.next("match-1")).resolves.toEqual({
      action: "map",
      map_name: "de_inferno",
    });

    expect(practice.changeRenderMap).toHaveBeenCalledWith(
      "session-1",
      "de_inferno",
    );
    // On the session before the level changes: the plugin reads its library
    // as the new map comes up.
    expect(renders.attachSession).toHaveBeenCalledWith(
      ["render-3", "render-5"],
      "session-1",
    );
    expect(renders.attachSession.mock.invocationCallOrder[0]).toBeLessThan(
      practice.changeRenderMap.mock.invocationCallOrder[0],
    );
    expect(renders.stampBootStage).toHaveBeenCalledWith(
      ["render-3", "render-5"],
      "changing_map:de_inferno",
    );
    expect(renders.stampBootStage).toHaveBeenCalledWith(
      ["render-4"],
      "waiting_for_map",
      null,
      { once: true },
    );
    expect(renders.handToPod).not.toHaveBeenCalled();
  });

  // A map disabled or deleted since its lineups were recorded. Answered with
  // "done", the pod stopped and the next one booked found the same map at the
  // head of the queue, forever, with every other map behind it.
  it("fails a map no server can be on and moves to the next one instead", async () => {
    queued = [
      { id: "render-3", map_name: "de_gone" },
      { id: "render-4", map_name: "de_inferno" },
      { id: "render-5", map_name: "de_gone" },
    ];
    practice.canPracticeOn.mockImplementation(
      async (mapName: string) => mapName !== "de_gone",
    );

    await expect(service.next("match-1")).resolves.toEqual({
      action: "map",
      map_name: "de_inferno",
    });

    expect(renders.failRenders).toHaveBeenCalledWith(
      ["render-3", "render-5"],
      expect.stringContaining("not available for practice"),
    );
    expect(practice.changeRenderMap).toHaveBeenCalledTimes(1);
    expect(practice.changeRenderMap).toHaveBeenCalledWith(
      "session-1",
      "de_inferno",
    );
  });

  it("goes idle rather than stop when the only maps left cannot be filmed", async () => {
    queued = [{ id: "render-3", map_name: "de_gone" }];
    practice.canPracticeOn.mockResolvedValue(false);

    await expect(service.next("match-1")).resolves.toEqual({
      action: "wait",
      seconds: UtilityRenderWorkerService.POLL_SECONDS,
    });
    expect(practice.changeRenderMap).not.toHaveBeenCalled();
  });

  // A level change is the one point where stopping throws nothing away.
  it("gives the GPU up at a map boundary when a live stream is waiting for it", async () => {
    queued = [{ id: "render-3", map_name: "de_inferno" }];
    liveStreamWaiting = true;

    await expect(service.next("match-1")).resolves.toEqual({ action: "done" });

    expect(practice.changeRenderMap).not.toHaveBeenCalled();
    expect(renders.failRenders).not.toHaveBeenCalled();
  });

  it("finishes the map it is on before a waiting live stream gets the GPU", async () => {
    queued = [{ id: "render-1", map_name: "de_mirage" }];
    liveStreamWaiting = true;

    await expect(service.next("match-1")).resolves.toMatchObject({
      action: "render",
    });
  });

  // The pod asking is what says it is still there, and what its GPU is held
  // on between lineups.
  it("notes that the pod is still there every time it asks", async () => {
    await service.next("match-1");

    expect(practice.touchRenderPod).toHaveBeenCalledWith("session-1");
  });

  // The row is the pod's once handed over. Anything that then stopped the
  // answer left it in flight, unfilmed, until the pod exited.
  it("still sends a lineup it has handed over when marking the others fails", async () => {
    queued = [
      { id: "render-1", map_name: "de_mirage" },
      { id: "render-2", map_name: "de_mirage" },
    ];
    renders.stampBootStage.mockRejectedValueOnce(new Error("db hiccup"));

    await expect(service.next("match-1")).resolves.toMatchObject({
      action: "render",
      jobs: [{ job_id: "render-1" }],
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("waits out the load screen before handing anything over", async () => {
    queued = [{ id: "render-3", map_name: "de_inferno" }];
    practice.renderSessionForMatch.mockResolvedValueOnce({
      ...SESSION,
      map_name: "de_inferno",
      map_changing_seconds: 12,
    });

    await expect(service.next("match-1")).resolves.toEqual({
      action: "wait",
      seconds: UtilityRenderWorkerService.POLL_SECONDS,
    });
    expect(renders.handToPod).not.toHaveBeenCalled();
  });

  // The pod stops, the batch job sees rows it never had, and books the map a
  // server of its own: the way it worked before, as the fallback.
  it("stops the pod when the level never comes up", async () => {
    practice.renderSessionForMatch.mockResolvedValueOnce({
      ...SESSION,
      map_changing_seconds:
        UtilityRenderWorkerService.MAP_CHANGE_TIMEOUT_SECONDS + 1,
    });

    await expect(service.next("match-1")).resolves.toEqual({ action: "done" });
  });

  it("stops the pod when the server cannot be moved", async () => {
    queued = [{ id: "render-3", map_name: "de_inferno" }];
    practice.changeRenderMap.mockRejectedValueOnce(
      new Error("could not reach the render's practice server"),
    );

    await expect(service.next("match-1")).resolves.toEqual({ action: "done" });
    expect(renders.stampBootStage).not.toHaveBeenCalled();
  });

  it("keeps the pod a moment when the queue empties, then lets it go", async () => {
    const now = jest.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_000_000);
      await expect(service.next("match-1")).resolves.toEqual({
        action: "wait",
        seconds: UtilityRenderWorkerService.POLL_SECONDS,
      });

      now.mockReturnValue(
        1_000_000 + (UtilityRenderWorkerService.IDLE_SECONDS - 1) * 1000,
      );
      await expect(service.next("match-1")).resolves.toEqual({
        action: "wait",
        seconds: UtilityRenderWorkerService.POLL_SECONDS,
      });

      now.mockReturnValue(
        1_000_000 + UtilityRenderWorkerService.IDLE_SECONDS * 1000,
      );
      await expect(service.next("match-1")).resolves.toEqual({
        action: "done",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("starts the wait over after filming something", async () => {
    const now = jest.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_000_000);
      await service.next("match-1");

      queued = [{ id: "render-1", map_name: "de_mirage" }];
      now.mockReturnValue(1_050_000);
      await service.next("match-1");

      queued = [];
      now.mockReturnValue(
        1_000_000 + UtilityRenderWorkerService.IDLE_SECONDS * 1000,
      );
      await expect(service.next("match-1")).resolves.toEqual({
        action: "wait",
        seconds: UtilityRenderWorkerService.POLL_SECONDS,
      });
    } finally {
      now.mockRestore();
    }
  });

  // An idle pod is holding the GPU somebody is waiting to go live on.
  it("does not wait on an empty queue while a live stream wants the GPU", async () => {
    liveStreamWaiting = true;

    await expect(service.next("match-1")).resolves.toEqual({ action: "done" });
  });

  // The pod asks only when it has nothing in hand. A lineup it was handed and
  // never started did not reach it: the answer carrying it was lost on the way
  // back. It used to sit in flight, unfilmed, until the pod exited.
  describe("a lineup handed over that never started", () => {
    beforeEach(() => {
      renders.strandedOnPod.mockResolvedValue(["render-9"]);
    });

    it("goes back in the queue, before the queue is read", async () => {
      await service.next("match-1");

      expect(renders.strandedOnPod).toHaveBeenCalledWith(
        "session-1",
        "gs-nades-queue",
      );
      expect(renders.releaseFromPod).toHaveBeenCalledWith(["render-9"]);
      expect(renders.failRenders).not.toHaveBeenCalled();
      expect(renders.releaseFromPod.mock.invocationCallOrder[0]).toBeLessThan(
        postgres.query.mock.invocationCallOrder[0],
      );
    });

    // A lineup the pod cannot take would otherwise be handed to it on every
    // request, for as long as it lived.
    it("is failed the second time, not offered for ever", async () => {
      await service.next("match-1");
      await service.next("match-1");

      expect(renders.releaseFromPod).toHaveBeenCalledTimes(1);
      expect(renders.failRenders).toHaveBeenCalledWith(
        ["render-9"],
        "handed to the render pod twice and never started",
      );
    });

    it("counts each lineup's chances on its own", async () => {
      await service.next("match-1");
      renders.strandedOnPod.mockResolvedValue(["render-9", "render-10"]);

      await service.next("match-1");

      expect(renders.failRenders).toHaveBeenCalledWith(
        ["render-9"],
        expect.any(String),
      );
      expect(renders.releaseFromPod).toHaveBeenLastCalledWith(["render-10"]);
    });
  });

  // Not a render session's pod at all: somebody else's practice match, or a
  // session no pod was ever started on.
  it("has nothing for a match that is not a render pod's", async () => {
    practice.renderSessionForMatch.mockResolvedValueOnce({
      ...SESSION,
      render_job_name: null,
    });

    await expect(service.next("match-1")).resolves.toEqual({ action: "done" });
    expect(renders.handToPod).not.toHaveBeenCalled();
    expect(practice.touchRenderPod).not.toHaveBeenCalled();
  });

  it("stops a pod whose session is gone", async () => {
    practice.renderSessionForMatch.mockResolvedValueOnce(null);
    await expect(service.next("match-1")).resolves.toEqual({ action: "done" });

    practice.renderSessionForMatch.mockResolvedValueOnce({
      ...SESSION,
      status: "Ended",
    });
    await expect(service.next("match-1")).resolves.toEqual({ action: "done" });
  });
});
