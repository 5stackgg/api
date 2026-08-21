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
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let steamAccounts: { claim: jest.Mock; release: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  const config = {
    get: (key: string) =>
      key === "gameServers"
        ? { namespace: "test", gameStreamerImage: "5stack/game-streamer" }
        : ({} as any),
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

  beforeEach(() => {
    createNamespacedJob.mockReset();
    readNamespacedJob.mockReset();
    // "absent" — nothing already running for this map.
    readNamespacedJob.mockRejectedValue({ code: 404 });

    postgres = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(async (fn: (client: unknown) => unknown) =>
        fn({
          query: jest
            .fn()
            .mockResolvedValue({ rows: [{ game_server_node_id: "node-A" }] }),
        }),
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

    service = new GameStreamerService(
      logger as any,
      config as any,
      hasura as any,
      postgres as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      {} as any,
      steamAccounts as any,
    );
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
        { addr: "1.2.3.4:27015", password: "server-pw" },
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

    it("sets NADE_BATCH_MODE so the pod never posts to the match's streamer status", async () => {
      await service.dispatchNadePreviews(
        "de_mirage",
        "match-1",
        { addr: "1.2.3.4:27015", password: "server-pw" },
        JOBS,
      );

      expect(envOf().NADE_BATCH_MODE).toBe("1");
    });

    it("hands the GPU and the Steam account back when the Job create fails", async () => {
      createNamespacedJob.mockRejectedValueOnce(new Error("k8s said no"));

      await expect(
        service.dispatchNadePreviews(
          "de_mirage",
          "match-1",
          { addr: "1.2.3.4:27015", password: "server-pw" },
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
          { addr: "1.2.3.4:27015", password: "server-pw" },
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
          { addr: "1.2.3.4:27015", password: "server-pw" },
          JOBS,
        ),
      ).rejects.toThrow("already running");

      expect(createNamespacedJob).not.toHaveBeenCalled();
      expect(steamAccounts.release).toHaveBeenCalledWith("gs-nades-demirage");
    });
  });
});
