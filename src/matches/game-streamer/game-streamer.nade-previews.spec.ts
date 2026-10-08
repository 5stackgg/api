const createNamespacedJob = jest.fn();
const readNamespacedJob = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    createNamespacedJob = createNamespacedJob;
    readNamespacedJob = readNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import { GameStreamerService } from "./game-streamer.service";

describe("GameStreamerService — nade previews", () => {
  let service: GameStreamerService;
  let postgres: { query: jest.Mock; transaction: jest.Mock };
  let claimClient: { query: jest.Mock };
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let steamAccounts: { claim: jest.Mock; release: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  let gameServers: Record<string, unknown>;
  const config = {
    get: (key: string) => (key === "gameServers" ? gameServers : ({} as any)),
  };

  const CONNECT = {
    addr: "1.2.3.4:27015",
    password: "server-pw",
    nodeId: "node-A",
  };

  const JOBS = [
    {
      job_id: "render-1",
      session_token: "token-1",
      spec: { lineup_id: "lineup-1", plugin_runtime: "swiftlys2" },
    },
  ];

  const envOf = () => {
    const body = createNamespacedJob.mock.calls[0][0].body;
    const env = body.spec.template.spec.containers[0].env as Array<{
      name: string;
      value: string;
    }>;
    return Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
  };

  const makeService = () =>
    new GameStreamerService(
      logger as any,
      config as any,
      hasura as any,
      postgres as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      {} as any,
      steamAccounts as any,
      { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
    );

  beforeEach(() => {
    gameServers = {
      namespace: "test",
      gameStreamerImage: "5stack/game-streamer",
      utilityRenderStreamerImage: null,
    };
    createNamespacedJob.mockReset();
    readNamespacedJob.mockReset();
    // "absent" — nothing already running for this map.
    readNamespacedJob.mockRejectedValue({ code: 404 });

    claimClient = {
      query: jest
        .fn()
        .mockResolvedValue({ rows: [{ game_server_node_id: "node-A" }] }),
    };
    postgres = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(async (fn: (client: unknown) => unknown) =>
        fn(claimClient),
      ),
    };
    hasura = {
      query: jest.fn().mockResolvedValue({ settings_by_pk: null }),
      mutation: jest.fn(),
    };
    steamAccounts = {
      claim: jest
        .fn()
        .mockResolvedValue({ id: "sa-1", username: "bot", password: "pw" }),
      release: jest.fn(),
    };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = makeService();
  });

  it("holds the spec port for a shader bake, so no streamer shares its node", () => {
    const body = (service as any).buildJobSpec(
      "warm-node-a",
      "",
      "warm-shaders",
      "node-A",
      [],
    );

    expect(body.spec.template.spec.containers[0].ports).toEqual([
      { name: "spec", containerPort: 1350 },
    ]);
  });

  describe("GetNadeRenderJobName", () => {
    it("is one pod per map, and a legal k8s name", () => {
      expect(GameStreamerService.GetNadeRenderJobName("de_mirage")).toBe(
        "gs-nades-demirage",
      );
      expect(
        GameStreamerService.GetNadeRenderJobName("de_dust2"),
      ).not.toEqual(GameStreamerService.GetNadeRenderJobName("de_mirage"));
      expect(
        GameStreamerService.GetNadeRenderJobName(
          "workshop/3070315843/de_some_absurdly_long_workshop_name",
        ),
      ).toMatch(/^gs-nades-[a-z0-9]{1,24}$/);
    });
  });

  describe("dispatchNadePreviews", () => {
    it("runs the nade-previews entrypoint with the batch and the connect info", async () => {
      const result = await service.dispatchNadePreviews(
        "de_mirage",
        "match-1",
        CONNECT,
        JOBS,
      );

      expect(result).toEqual({ jobName: "gs-nades-demirage", nodeId: "node-A" });

      const body = createNamespacedJob.mock.calls[0][0].body;
      expect(body.spec.template.spec.containers[0].args).toEqual([
        "nade-previews",
      ]);
      expect(body.metadata.labels["utility-map"]).toBe("de_mirage");

      const env = envOf();
      expect(env.NADE_CONNECT_ADDR).toBe("1.2.3.4:27015");
      expect(env.NADE_CONNECT_PASSWORD).toBe("server-pw");
      expect(JSON.parse(env.NADE_BATCH_JOBS)).toEqual([
        {
          job_id: "render-1",
          token: "token-1",
          spec: { lineup_id: "lineup-1", plugin_runtime: "swiftlys2" },
        },
      ]);
    });

    it("claims the GPU on the practice server's own node", async () => {
      await service.dispatchNadePreviews("de_mirage", "match-1", CONNECT, JOBS);

      const claimQuery = claimClient.query.mock.calls[0];
      expect(claimQuery[0]).toContain("claim_gpu_node_for_render($2)");
      expect(claimQuery[1]).toEqual([["render-1"], "node-A"]);
    });

    it("films with the render-only streamer image when one is set", async () => {
      gameServers.utilityRenderStreamerImage = "5stack/game-streamer:dev";
      service = makeService();

      await service.dispatchNadePreviews("de_mirage", "match-1", CONNECT, JOBS);

      const body = createNamespacedJob.mock.calls[0][0].body;
      expect(body.spec.template.spec.containers[0].image).toBe(
        "5stack/game-streamer:dev",
      );
    });

    it("keeps the shared streamer image when no render image is set", async () => {
      await service.dispatchNadePreviews("de_mirage", "match-1", CONNECT, JOBS);

      const body = createNamespacedJob.mock.calls[0][0].body;
      expect(body.spec.template.spec.containers[0].image).toBe(
        "5stack/game-streamer",
      );
    });

    it("sets NADE_BATCH_MODE so the pod never posts to the match's streamer status", async () => {
      await service.dispatchNadePreviews(
        "de_mirage",
        "match-1",
        CONNECT,
        JOBS,
      );

      expect(envOf().NADE_BATCH_MODE).toBe("1");
    });

    it("never hands the pod a lineup name to type into chat", async () => {
      await service.dispatchNadePreviews("de_mirage", "match-1", CONNECT, JOBS);

      const env = envOf();
      expect(env.NADE_CMD_LOAD).toBeUndefined();
      expect(env.NADE_CMD_THROW).toBeUndefined();
    });

    it("hands the GPU and the Steam account back when the Job create fails", async () => {
      createNamespacedJob.mockRejectedValueOnce(new Error("k8s said no"));

      await expect(
        service.dispatchNadePreviews(
          "de_mirage",
          "match-1",
          CONNECT,
          JOBS,
        ),
      ).rejects.toThrow("k8s said no");

      expect(steamAccounts.release).toHaveBeenCalledWith("gs-nades-demirage");
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE utility_lineup_renders"),
        ["de_mirage"],
      );
    });

    it("refuses to dispatch an empty batch", async () => {
      await expect(
        service.dispatchNadePreviews(
          "de_mirage",
          "match-1",
          CONNECT,
          [],
        ),
      ).rejects.toThrow("no nade render jobs");
      expect(steamAccounts.claim).not.toHaveBeenCalled();
    });

    it("will not start a second pod for a map that already has one running", async () => {
      readNamespacedJob.mockReset();
      readNamespacedJob.mockResolvedValue({ status: { active: 1 } });

      await expect(
        service.dispatchNadePreviews(
          "de_mirage",
          "match-1",
          CONNECT,
          JOBS,
        ),
      ).rejects.toThrow("already running");

      expect(createNamespacedJob).not.toHaveBeenCalled();
      expect(steamAccounts.release).toHaveBeenCalledWith("gs-nades-demirage");
    });
  });
});
