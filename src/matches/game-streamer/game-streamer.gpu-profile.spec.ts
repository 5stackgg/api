const createNamespacedJob = jest.fn();
const readNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const listNamespacedPod = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    createNamespacedJob = createNamespacedJob;
    readNamespacedJob = readNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = listNamespacedPod;
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
  GPU_NODE_PROFILE_SQL,
  GpuProfileUnavailableError,
} from "./game-streamer.service";

describe("GameStreamerService GPU node profile", () => {
  let service: GameStreamerService;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let postgres: { query: jest.Mock; transaction: jest.Mock };

  const config = {
    get: (key: string) =>
      key === "gameServers"
        ? { namespace: "test", gameStreamerImage: "5stack/game-streamer:test" }
        : ({} as any),
  };

  beforeEach(() => {
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    postgres = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(),
    };

    service = new GameStreamerService(
      logger as any,
      config as any,
      { query: jest.fn(), mutation: jest.fn() } as any,
      postgres as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      {} as any,
      { claim: jest.fn(), release: jest.fn() } as any,
      { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
    );
  });

  describe("resolveGpuNodeProfile", () => {
    const resolve = (nodeId: string) =>
      service["resolveGpuNodeProfile"](nodeId);

    const expectOneRead = (nodeId: string) => {
      expect(postgres.query).toHaveBeenCalledTimes(1);
      expect(postgres.query).toHaveBeenCalledWith(GPU_NODE_PROFILE_SQL, [
        nodeId,
      ]);
    };

    it("returns null when the node has no row", async () => {
      postgres.query.mockResolvedValueOnce([]);
      await expect(resolve("node-1")).resolves.toBeNull();
      expectOneRead("node-1");
    });

    it("returns null for a null vendor", async () => {
      postgres.query.mockResolvedValueOnce([
        { gpu_vendor: null, pci_address: "0000:01:00.0" },
      ]);
      await expect(resolve("node-1")).resolves.toBeNull();
      expectOneRead("node-1");
    });

    it("returns the nvidia profile", async () => {
      postgres.query.mockResolvedValueOnce([
        { gpu_vendor: "nvidia", pci_address: "0000:01:00.0" },
      ]);
      await expect(resolve("node-1")).resolves.toStrictEqual({
        vendor: "nvidia",
      });
      expectOneRead("node-1");
    });

    it("returns the amd profile for a valid address", async () => {
      postgres.query.mockResolvedValueOnce([
        { gpu_vendor: "amd", pci_address: "0000:c4:00.0" },
      ]);
      await expect(resolve("node-1")).resolves.toStrictEqual({
        vendor: "amd",
        pciAddress: "0000:c4:00.0",
      });
      expectOneRead("node-1");
    });

    it("lowercases an uppercase address", async () => {
      postgres.query.mockResolvedValueOnce([
        { gpu_vendor: "amd", pci_address: "0000:C4:00.0" },
      ]);
      await expect(resolve("node-1")).resolves.toStrictEqual({
        vendor: "amd",
        pciAddress: "0000:c4:00.0",
      });
      expectOneRead("node-1");
    });

    it.each([null, "c4:00.0", "0000:c4:00.8", "/dev/dri/renderD128"])(
      "throws GpuProfileUnavailableError for amd with the address %p",
      async (address) => {
        postgres.query.mockResolvedValueOnce([
          { gpu_vendor: "amd", pci_address: address },
        ]);
        const error = await resolve("node-bad").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GpuProfileUnavailableError);
        expect((error as Error).message).toContain("node-bad");
        expect((error as Error).message).toContain("disable the node");
        expectOneRead("node-bad");
      },
    );

    it("throws GpuProfileUnavailableError for the unknown vendor intel", async () => {
      postgres.query.mockResolvedValueOnce([
        { gpu_vendor: "intel", pci_address: "0000:00:02.0" },
      ]);
      const error = await resolve("node-bad").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GpuProfileUnavailableError);
      expect((error as Error).message).toContain("node-bad");
      expect((error as Error).message).toContain("disable the node");
      expectOneRead("node-bad");
    });

    it("returns null with exactly one error log when the column is missing (42703)", async () => {
      postgres.query.mockRejectedValueOnce(
        Object.assign(new Error('column "gpu_vendor" does not exist'), {
          code: "42703",
        }),
      );
      await expect(resolve("node-1")).resolves.toBeNull();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toContain(
        "1889000001250_game_server_nodes_gpu_vendor",
      );
      expectOneRead("node-1");
    });

    it("rethrows any other database error", async () => {
      const failure = Object.assign(new Error("terminating connection"), {
        code: "57P01",
      });
      postgres.query.mockRejectedValueOnce(failure);
      await expect(resolve("node-1")).rejects.toBe(failure);
      expect(logger.error).not.toHaveBeenCalled();
      expectOneRead("node-1");
    });

    it("reads the row again on every call, so a vendor change reaches the next Job", async () => {
      postgres.query
        .mockResolvedValueOnce([{ gpu_vendor: "nvidia", pci_address: null }])
        .mockResolvedValueOnce([
          { gpu_vendor: "amd", pci_address: "0000:c4:00.0" },
        ]);
      await expect(resolve("node-1")).resolves.toStrictEqual({
        vendor: "nvidia",
      });
      await expect(resolve("node-1")).resolves.toStrictEqual({
        vendor: "amd",
        pciAddress: "0000:c4:00.0",
      });
      expect(postgres.query).toHaveBeenCalledTimes(2);
    });
  });
});

// Each dispatch path reads its node's profile inside its existing cleanup
// scope and passes it to buildJobSpec.
describe("GameStreamerService GPU profile on the dispatch paths", () => {
  const NODE_ID = "node-golden";
  const MATCH_ID = "match-golden";
  const MATCH_MAP_ID = "map-golden";
  const DEMO_ID = "demo-golden";
  const SESSION_ID = "session-golden";
  const MAP_NAME = "de_mirage";
  const STEAM_ACCOUNT = {
    id: "sa-golden",
    username: "golden-bot",
    password: "golden-pw",
  };
  const AMD_ROW = { gpu_vendor: "amd", pci_address: "0000:c4:00.0" };
  const JOBS = [{ job_id: "clip-1", session_token: "token-1", spec: {} }];
  const DEMO_ROW: Record<string, unknown> = {
    id: DEMO_ID,
    match_id: MATCH_ID,
    match_map_id: MATCH_MAP_ID,
    file: "golden.dem",
    total_ticks: null,
    tick_rate: null,
    round_ticks: null,
    workshop_id: null,
    cs2_build: null,
  };
  const MATCH_ROW: Record<string, unknown> = {
    id: MATCH_ID,
    status: "Live",
    password: "match-pw",
    server: {
      host: "10.0.0.5",
      port: 27015,
      tv_port: null,
      connected: true,
      enabled: true,
      server_region: { is_lan: false },
      game_server_node: { node_ip: null },
    },
  };
  const NODE_ROW: Record<string, unknown> = {
    id: NODE_ID,
    gpu: true,
    shader_bake_status: null,
    cs2_video_settings: null,
  };

  // The config of game-streamer.job-spec.spec.ts, so the bake Job below can
  // be compared with its warm-shaders golden.
  const config = {
    get: (key: string) => {
      if (key === "gameServers") {
        return {
          namespace: "test",
          gameStreamerImage: "5stack/game-streamer:golden",
        };
      }
      if (key === "app") {
        return { encSecret: "job-spec-fixture" };
      }
      if (key === "steam") {
        return { steamUser: "config-bot", steamPassword: "config-pw" };
      }
      return {} as any;
    },
  };

  let service: GameStreamerService;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let postgres: { query: jest.Mock; transaction: jest.Mock };
  let steamAccounts: { claim: jest.Mock; release: jest.Mock };
  let readProfile: () => Promise<unknown>;
  let buildJobSpec: jest.SpyInstance;
  let deleteJob: jest.SpyInstance;
  let waitForJobGone: jest.SpyInstance;
  let setBakeStatus: jest.SpyInstance;
  let stopDemoSessionById: jest.SpyInstance;
  let unregisterStreamRow: jest.SpyInstance;
  let releaseNadeRenderClaim: jest.SpyInstance;

  const stub = (name: string) =>
    jest.spyOn(service as any, name).mockResolvedValue(undefined);

  beforeEach(() => {
    delete process.env.API_INTERNAL_BASE;
    delete process.env.GAME_STREAM_DOMAIN;
    delete process.env.DEBUG_STREAM;
    delete process.env.GAME_STREAMER_DISPLAY_TIER;
    // bakeShaders starts its monitor through a 5 s setTimeout.
    jest.useFakeTimers();

    createNamespacedJob.mockReset().mockResolvedValue({});
    // 404: no Job of that name exists, so every wait loop ends at once.
    readNamespacedJob.mockReset().mockRejectedValue({ code: 404 });
    deleteNamespacedJob.mockReset().mockResolvedValue({});
    listNamespacedPod.mockReset().mockResolvedValue({ items: [] });

    readProfile = async () => [AMD_ROW];
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    postgres = {
      query: jest.fn((sql: string) =>
        sql === GPU_NODE_PROFILE_SQL ? readProfile() : Promise.resolve([]),
      ),
      transaction: jest.fn(async (fn: (client: unknown) => unknown) =>
        fn({
          query: jest
            .fn()
            .mockResolvedValue({ rows: [{ game_server_node_id: NODE_ID }] }),
        }),
      ),
    };
    steamAccounts = {
      claim: jest.fn().mockResolvedValue(STEAM_ACCOUNT),
      release: jest.fn(),
    };

    service = new GameStreamerService(
      logger as any,
      config as any,
      {
        query: jest.fn(async (query: Record<string, unknown>) => {
          if ("match_map_demos" in query) {
            return { match_map_demos: [DEMO_ROW] };
          }
          if ("matches_by_pk" in query) {
            return { matches_by_pk: MATCH_ROW };
          }
          if ("game_server_nodes_by_pk" in query) {
            return { game_server_nodes_by_pk: NODE_ROW };
          }
          return {};
        }),
        mutation: jest.fn(async (mutation: Record<string, unknown>) =>
          "insert_match_demo_sessions_one" in mutation
            ? { insert_match_demo_sessions_one: { id: SESSION_ID } }
            : {},
        ),
      } as any,
      postgres as any,
      { getConnection: jest.fn() } as any,
      {
        resolvePlayableDemoUrl: jest
          .fn()
          .mockResolvedValue("https://demos.test/golden.dem"),
      } as any,
      {} as any,
      steamAccounts as any,
      { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
    );

    buildJobSpec = jest.spyOn(service as any, "buildJobSpec");
    deleteJob = jest.spyOn(service as any, "deleteJob");
    waitForJobGone = jest.spyOn(service as any, "waitForJobGone");
    setBakeStatus = jest.spyOn(service as any, "setBakeStatus");
    stopDemoSessionById = stub("stopDemoSessionById");
    unregisterStreamRow = stub("unregisterStreamRow");
    releaseNadeRenderClaim = stub("releaseNadeRenderClaim");
    stub("createDemoService");
    stub("createLiveService");
    stub("monitorBakeShaders");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createdBody = () => createNamespacedJob.mock.calls[0][0].body;

  // buildJobSpec without its gpu argument: the Job each path built before
  // the profile existed. The prototype method does not go through the spy.
  const nvidiaBuild = (...args: unknown[]) =>
    Reflect.apply(GameStreamerService.prototype["buildJobSpec"], service, args);

  const profileReads = () =>
    postgres.query.mock.calls.filter(([sql]) => sql === GPU_NODE_PROFILE_SQL)
      .length;

  const PATHS: Array<{
    name: string;
    start: () => Promise<unknown>;
    expectCleanup: () => void;
  }> = [
    {
      name: "demo",
      start: () =>
        service.startDemoPlayback(MATCH_MAP_ID, "76561198000000001", {
          demoId: DEMO_ID,
          demoFile: "golden.dem",
          presignedDemoUrl: "https://demos.test/golden.dem",
          roundTicks: null,
          totalTicks: null,
          tickRate: null,
          workshopId: null,
          cs2Build: null,
        }),
      expectCleanup: () => {
        expect(stopDemoSessionById).toHaveBeenCalledWith(
          SESSION_ID,
          "gs-demo-sessiongolde",
        );
      },
    },
    {
      name: "live",
      start: () => service.startLive(MATCH_ID, "live"),
      expectCleanup: () => {
        expect(unregisterStreamRow).toHaveBeenCalledWith(MATCH_ID);
      },
    },
    {
      name: "batch",
      start: () => service.dispatchBatchHighlights(MATCH_MAP_ID, JOBS, DEMO_ID),
      expectCleanup: () => {
        expect(postgres.query).toHaveBeenCalledWith(
          expect.stringContaining("UPDATE clip_render_jobs"),
          [MATCH_MAP_ID, DEMO_ID],
        );
        expect(steamAccounts.release).toHaveBeenCalledWith(
          "gs-batch-mapgolde-demogold",
        );
      },
    },
    {
      name: "nades",
      start: () =>
        service.dispatchNadePreviews(
          MAP_NAME,
          MATCH_ID,
          { addr: "127.0.0.1:27015", password: "server-pw", nodeId: NODE_ID },
          JOBS,
        ),
      expectCleanup: () => {
        expect(releaseNadeRenderClaim).toHaveBeenCalledWith(
          ["clip-1"],
          "gs-nades-queue",
        );
      },
    },
    {
      name: "bake",
      start: () => service.bakeShaders(NODE_ID),
      expectCleanup: () => {
        const read = postgres.query.mock.calls.findIndex(
          ([sql]) => sql === GPU_NODE_PROFILE_SQL,
        );
        const readOrder = postgres.query.mock.invocationCallOrder[read];
        expect(deleteJob.mock.invocationCallOrder[0]).toBeLessThan(
          waitForJobGone.mock.invocationCallOrder[0],
        );
        expect(waitForJobGone.mock.invocationCallOrder[0]).toBeLessThan(
          readOrder,
        );
        expect(readOrder).toBeLessThan(
          setBakeStatus.mock.invocationCallOrder[0],
        );
        expect(setBakeStatus).toHaveBeenCalledTimes(1);
        expect(setBakeStatus).toHaveBeenCalledWith(NODE_ID, "errored");
        expect(steamAccounts.claim).not.toHaveBeenCalled();
      },
    },
  ];

  it.each(PATHS)(
    "$name passes the amd profile of its node to buildJobSpec",
    async (path) => {
      await path.start();

      expect(postgres.query).toHaveBeenCalledWith(GPU_NODE_PROFILE_SQL, [
        NODE_ID,
      ]);
      expect(profileReads()).toBe(1);
      expect(buildJobSpec).toHaveBeenCalledTimes(1);
      expect(buildJobSpec.mock.calls[0][7]).toStrictEqual({
        vendor: "amd",
        pciAddress: "0000:c4:00.0",
      });
      expect(createNamespacedJob).toHaveBeenCalledTimes(1);
      const body = createdBody();
      expect(body).toBe(buildJobSpec.mock.results[0].value);
      expect(body.metadata.labels["5stack-gpu-vendor"]).toBe("amd");
      expect(body.spec.template.spec.containers[0].env.at(-1)).toStrictEqual({
        name: "GS_GPU_PCI_ADDRESS",
        value: "0000:c4:00.0",
      });
    },
  );

  describe.each([
    [
      "an amd row without a PCI address",
      { gpu_vendor: "amd", pci_address: null },
    ],
    [
      "the unknown vendor intel",
      { gpu_vendor: "intel", pci_address: "0000:00:02.0" },
    ],
  ])("with %s", (_label, row) => {
    it.each(PATHS)(
      "$name creates no Job and runs its cleanup",
      async (path) => {
        readProfile = async () => [row];

        await expect(path.start()).rejects.toBeInstanceOf(
          GpuProfileUnavailableError,
        );
        expect(buildJobSpec).not.toHaveBeenCalled();
        expect(createNamespacedJob).not.toHaveBeenCalled();
        path.expectCleanup();
      },
    );
  });

  it.each(PATHS.filter((path) => path.name !== "bake"))(
    "$name runs the same cleanup on any other database error",
    async (path) => {
      const failure = Object.assign(new Error("terminating connection"), {
        code: "57P01",
      });
      readProfile = async () => {
        throw failure;
      };

      await expect(path.start()).rejects.toBe(failure);
      expect(createNamespacedJob).not.toHaveBeenCalled();
      path.expectCleanup();
    },
  );

  // A bake has no cleanup scope before its Steam claim, so a database error
  // rethrows as any other error there does today.
  it("bake rethrows any other database error without errored or a Steam claim", async () => {
    const failure = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    });
    readProfile = async () => {
      throw failure;
    };

    await expect(service.bakeShaders(NODE_ID)).rejects.toBe(failure);
    expect(setBakeStatus).not.toHaveBeenCalled();
    expect(steamAccounts.claim).not.toHaveBeenCalled();
    expect(createNamespacedJob).not.toHaveBeenCalled();
  });

  it.each(PATHS)(
    "$name builds the NVIDIA Job when gpu_vendor is missing (42703)",
    async (path) => {
      readProfile = async () => {
        throw Object.assign(new Error('column "gpu_vendor" does not exist'), {
          code: "42703",
        });
      };

      await path.start();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(buildJobSpec).toHaveBeenCalledTimes(1);
      const args = buildJobSpec.mock.calls[0];
      expect(args[7]).toBeNull();
      const body = createdBody();
      expect(body).toStrictEqual(nvidiaBuild(...args.slice(0, 7)));
      expect(body.spec.template.spec.runtimeClassName).toBe("nvidia");
    },
  );

  describe("bakeShaders profile", () => {
    // The warm-shaders inputs that game-streamer.job-spec.spec.ts pins to its
    // snapshot, built in the same config.
    const goldenBake = () =>
      nvidiaBuild(
        "shader-bake-node-golden",
        NODE_ID,
        "warm-shaders",
        NODE_ID,
        [
          { name: "BAKE_NODE_ID", value: NODE_ID },
          { name: "CS2_VIDEO_SETTINGS", value: "{}" },
        ],
        { "node-id": NODE_ID },
        STEAM_ACCOUNT,
      );

    it("an amd row gives the AMD bake Job", async () => {
      await service.bakeShaders(NODE_ID);

      const body = createdBody();
      const pod = body.spec.template.spec;
      expect(pod).not.toHaveProperty("runtimeClassName");
      expect(pod.containers[0].resources).toStrictEqual({
        limits: { memory: "16Gi" },
        requests: { memory: "8Gi" },
      });
      expect(body.metadata.labels["5stack-gpu-vendor"]).toBe("amd");
      expect(body.spec.template.metadata.labels["5stack-gpu-vendor"]).toBe(
        "amd",
      );
      expect(pod.containers[0].env.at(-1)).toStrictEqual({
        name: "GS_GPU_PCI_ADDRESS",
        value: "0000:c4:00.0",
      });
    });

    const NON_AMD_ROWS: Array<[string, Array<Record<string, unknown>>]> = [
      [
        "an nvidia row",
        [{ gpu_vendor: "nvidia", pci_address: "0000:01:00.0" }],
      ],
      ["a null vendor", [{ gpu_vendor: null, pci_address: null }]],
      ["no row", []],
    ];

    it.each(NON_AMD_ROWS)(
      "%s gives the warm-shaders golden",
      async (_label, rows) => {
        readProfile = async () => rows;

        await service.bakeShaders(NODE_ID);

        expect(createdBody()).toStrictEqual(goldenBake());
      },
    );

    it("an amd row with tier C ends the env with GS_DISPLAY_TIER", async () => {
      process.env.GAME_STREAMER_DISPLAY_TIER = "C";

      await service.bakeShaders(NODE_ID);

      expect(
        createdBody().spec.template.spec.containers[0].env.slice(-2),
      ).toStrictEqual([
        { name: "GS_GPU_PCI_ADDRESS", value: "0000:c4:00.0" },
        { name: "GS_DISPLAY_TIER", value: "C" },
      ]);
    });

    // The golden is built before the env is set.
    it.each(NON_AMD_ROWS)(
      "%s with tier C gives the warm-shaders golden",
      async (_label, rows) => {
        const golden = goldenBake();
        readProfile = async () => rows;
        process.env.GAME_STREAMER_DISPLAY_TIER = "C";

        await service.bakeShaders(NODE_ID);

        expect(createdBody()).toStrictEqual(golden);
      },
    );
  });
});
