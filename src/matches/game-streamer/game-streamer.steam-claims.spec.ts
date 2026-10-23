const createNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const readNamespacedJob = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    createNamespacedJob = createNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
    readNamespacedJob = readNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = jest.fn().mockResolvedValue({ items: [] });
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import {
  GameStreamerService,
  NoGpuAvailableError,
} from "./game-streamer.service";

describe("GameStreamerService — steam account claims", () => {
  let service: GameStreamerService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let claimClient: { query: jest.Mock };
  let claims: Map<string, string>;

  const config = {
    get: (key: string) => {
      if (key === "gameServers") {
        return { namespace: "test", gameStreamerImage: "5stack/game-streamer" };
      }
      if (key === "app") {
        return { encSecret: "test-secret", gameStreamDomain: "https://tv" };
      }
      return {} as any;
    },
  };

  const LIVE_MATCH = {
    matches_by_pk: {
      id: "match-1",
      status: "Live",
      password: "pw",
      server: { connected: true, enabled: true },
    },
  };

  const steamUserOfLaunchedPod = () => {
    const body = createNamespacedJob.mock.calls[0][0].body;
    const env = body.spec.template.spec.containers[0].env as Array<{
      name: string;
      value: string;
    }>;
    return env.find((entry) => entry.name === "STEAM_USER")?.value;
  };

  beforeEach(() => {
    createNamespacedJob.mockReset().mockResolvedValue({});
    deleteNamespacedJob.mockReset().mockRejectedValue({ code: 404 });
    readNamespacedJob.mockReset().mockRejectedValue({ code: 404 });
    claims = new Map();
    hasura = { query: jest.fn(), mutation: jest.fn() };

    claimClient = {
      query: jest
        .fn()
        .mockResolvedValue({ rows: [{ game_server_node_id: "node-A" }] }),
    };
    const steamAccounts = {
      claim: jest.fn(async ({ jobName }: { jobName: string }) => {
        claims.set(jobName, "pool-1");
        return { id: "sa-1", username: "pool-1", password: "pw" };
      }),
      release: jest.fn(async (jobName: string) => {
        claims.delete(jobName);
      }),
    };

    service = new GameStreamerService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      config as any,
      hasura as any,
      {
        query: jest.fn().mockResolvedValue([]),
        transaction: jest.fn(async (fn: (client: unknown) => unknown) =>
          fn(claimClient),
        ),
      } as any,
      { getConnection: jest.fn() } as any,
      {
        resolvePlayableDemoUrl: jest.fn().mockResolvedValue("https://demo"),
      } as any,
      {} as any,
      steamAccounts as any,
      { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
    );

    for (const method of [
      "resolveHudEnv",
      "buildNodeCs2OptionsEnv",
      "buildConnectEnv",
    ]) {
      jest.spyOn(service as any, method).mockResolvedValue([]);
    }
    for (const method of [
      "resolveLiveVideoCodec",
      "resolveClipVideoCodec",
      "resolveClipBakeBranding",
    ]) {
      jest.spyOn(service as any, method).mockResolvedValue("h264");
    }
    jest.spyOn(service as any, "readUsePlaycast").mockResolvedValue(false);
    jest
      .spyOn(service as any, "createLiveService")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "createDemoService")
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, "findDemoSession").mockResolvedValue(null);
  });

  it("keeps the live stream's account claimed while its pod runs on it", async () => {
    hasura.query.mockImplementation(async (selector: Record<string, any>) =>
      selector.match_streams
        ? {
            match_streams: [
              {
                k8s_service_name:
                  createNamespacedJob.mock.calls[0]?.[0].body.metadata.name,
              },
            ],
          }
        : LIVE_MATCH,
    );

    await expect(service.startLive("match-1", "live")).resolves.toEqual({
      status: "booting",
    });

    expect(steamUserOfLaunchedPod()).toBe("pool-1");
    const jobName = createNamespacedJob.mock.calls[0][0].body.metadata.name;
    expect(claims.get(jobName)).toBe("pool-1");
  });

  it("leaves a running stream alone when its restart has to wait for a GPU", async () => {
    hasura.query.mockResolvedValue(LIVE_MATCH);
    claimClient.query.mockImplementation(async (sql: string) =>
      sql.includes("count(*)") ? { rows: [{ n: 1 }] } : { rows: [] },
    );
    const jobName = "gs-live-match-1";
    claims.set(jobName, "pool-1");

    await expect(service.startLive("match-1", "live")).resolves.toEqual({
      status: "pending",
    });

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(claims.get(jobName)).toBe("pool-1");
  });

  it("keeps a demo session's account claimed while its pod runs on it", async () => {
    hasura.query
      .mockResolvedValueOnce({ match_map_demos: [{ match_id: "match-1" }] })
      .mockResolvedValueOnce({ matches_by_pk: { id: "match-1" } });
    hasura.mutation
      .mockResolvedValueOnce({
        insert_match_demo_sessions_one: {
          id: "11111111-2222-3333-4444-555555555555",
        },
      })
      .mockResolvedValue({});

    const { sessionId } = await service.startDemoPlayback(
      "map-1",
      "76561198000000000",
      {
        demoId: "demo-1",
        demoFile: "demo.dem",
        presignedDemoUrl: "https://demo",
        roundTicks: null,
        totalTicks: null,
        tickRate: null,
        workshopId: null,
        cs2Build: null,
      },
    );

    expect(steamUserOfLaunchedPod()).toBe("pool-1");
    expect(
      claims.get(GameStreamerService.GetDemoJobIdForSession(sessionId)),
    ).toBe("pool-1");
  });

  it("keeps a re-render's account claimed after reaping the map's finished pod", async () => {
    hasura.query.mockResolvedValue({
      match_map_demos: [
        {
          id: "demo-1",
          match_id: "match-1",
          match_map_id: "map-1",
          file: "demo.dem",
        },
      ],
    });
    readNamespacedJob
      .mockResolvedValueOnce({ status: { succeeded: 1 } })
      .mockRejectedValue({ code: 404 });

    await service.dispatchBatchHighlights(
      "map-1",
      [{ job_id: "clip-1", session_token: "token-1", spec: {} }],
      "demo-1",
    );

    expect(steamUserOfLaunchedPod()).toBe("pool-1");
    expect(
      claims.get(
        GameStreamerService.GetBatchHighlightsJobName("map-1", "demo-1"),
      ),
    ).toBe("pool-1");
  });

  it("waits for a map's running pod instead of claiming over it", async () => {
    hasura.query.mockResolvedValue({
      match_map_demos: [
        {
          id: "demo-1",
          match_id: "match-1",
          match_map_id: "map-1",
          file: "demo.dem",
        },
      ],
    });
    readNamespacedJob.mockResolvedValue({ status: { active: 1 } });
    const jobName = GameStreamerService.GetBatchHighlightsJobName(
      "map-1",
      "demo-1",
    );
    claims.set(jobName, "running-pod");

    await expect(
      service.dispatchBatchHighlights(
        "map-1",
        [{ job_id: "clip-1", session_token: "token-1", spec: {} }],
        "demo-1",
      ),
    ).rejects.toBeInstanceOf(NoGpuAvailableError);

    expect(claims.get(jobName)).toBe("running-pod");
    expect(createNamespacedJob).not.toHaveBeenCalled();
  });
});
