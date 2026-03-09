jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn().mockReturnValue({
      createNamespacedDeployment: jest.fn().mockResolvedValue({}),
      deleteNamespacedDeployment: jest.fn().mockResolvedValue({}),
      readNamespacedDeployment: jest.fn().mockResolvedValue({
        status: { readyReplicas: 1 },
        spec: { replicas: 1 },
      }),
    }),
  })),
  CoreV1Api: jest.fn(),
  AppsV1Api: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { DedicatedServersService } from "./dedicated-servers.service";

function createService(overrides: {
  hasura?: Record<string, any>;
  redis?: Record<string, any>;
  rcon?: Record<string, any>;
} = {}) {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
    ...overrides.hasura,
  };

  const redis = {
    hdel: jest.fn().mockResolvedValue(1),
    hset: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn().mockResolvedValue({}),
    expire: jest.fn().mockResolvedValue(1),
    ...overrides.redis,
  };

  const redisManager = {
    getConnection: jest.fn().mockReturnValue(redis),
  };

  const rcon = {
    connect: jest.fn().mockResolvedValue({ send: jest.fn() }),
    disconnect: jest.fn(),
    ...overrides.rcon,
  };

  const encryption = { decrypt: jest.fn().mockResolvedValue("decrypted") };
  const systemService = { restartDeployment: jest.fn().mockResolvedValue(undefined) };

  const config = {
    get: jest.fn((key: string) => {
      if (key === "app")
        return {
          apiDomain: "api.test",
          relayDomain: "relay.test",
          demosDomain: "demos.test",
          wsDomain: "ws.test",
        };
      if (key === "gameServers")
        return { namespace: "test-ns", serverImage: "img:latest" };
      return {};
    }),
  };

  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    verbose: jest.fn(),
  } as unknown as Logger;

  const service = new DedicatedServersService(
    logger,
    config as any,
    hasura as any,
    encryption as any,
    rcon as any,
    redisManager as any,
    systemService as any,
  );

  return { service, hasura, redis, rcon, encryption, systemService, logger };
}

describe("DedicatedServersService", () => {
  describe("removeDedicatedServer", () => {
    it("deletes deployment, cleans redis, and updates hasura", async () => {
      const { service, hasura, redis } = createService();

      await service.removeDedicatedServer("server-1");

      expect(redis.hdel).toHaveBeenCalledWith(
        "dedicated-servers:stats",
        "server-1",
      );
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_servers_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              pk_columns: { id: "server-1" },
              _set: { connected: false, steam_relay: null },
            }),
          }),
        }),
      );
    });

    it("swallows 404 errors from k8s", async () => {
      const { service } = createService();

      // The apps mock will throw 404 - we need to override the internal apps client
      // Since the constructor creates the k8s client, we access it via the mock
      const appsClient = (service as any).apps;
      appsClient.deleteNamespacedDeployment = jest
        .fn()
        .mockRejectedValue({ code: 404 });

      await expect(
        service.removeDedicatedServer("server-1"),
      ).resolves.toBeUndefined();
    });

    it("rethrows non-404 errors from k8s", async () => {
      const { service } = createService();

      const appsClient = (service as any).apps;
      appsClient.deleteNamespacedDeployment = jest
        .fn()
        .mockRejectedValue({ code: 500 });

      await expect(service.removeDedicatedServer("server-1")).rejects.toEqual({
        code: 500,
      });
    });
  });

  describe("getGameType (private)", () => {
    it("returns 0 for Ranked, Casual, Competitive, Wingman", () => {
      const { service } = createService();
      const getGameType = (service as any).getGameType.bind(service);

      expect(getGameType("Ranked")).toBe(0);
      expect(getGameType("Casual")).toBe(0);
      expect(getGameType("Competitive")).toBe(0);
      expect(getGameType("Wingman")).toBe(0);
    });

    it("returns 1 for Deathmatch, ArmsRace", () => {
      const { service } = createService();
      const getGameType = (service as any).getGameType.bind(service);

      expect(getGameType("Deathmatch")).toBe(1);
      expect(getGameType("ArmsRace")).toBe(1);
    });

    it("returns 3 for Retake, Custom", () => {
      const { service } = createService();
      const getGameType = (service as any).getGameType.bind(service);

      expect(getGameType("Retake")).toBe(3);
      expect(getGameType("Custom")).toBe(3);
    });
  });

  describe("getGameMode (private)", () => {
    it("returns 1 for Ranked, Competitive", () => {
      const { service } = createService();
      const getGameMode = (service as any).getGameMode.bind(service);

      expect(getGameMode("Ranked")).toBe(1);
      expect(getGameMode("Competitive")).toBe(1);
    });

    it("returns 0 for ArmsRace, Casual, Retake, Custom", () => {
      const { service } = createService();
      const getGameMode = (service as any).getGameMode.bind(service);

      expect(getGameMode("ArmsRace")).toBe(0);
      expect(getGameMode("Casual")).toBe(0);
      expect(getGameMode("Retake")).toBe(0);
      expect(getGameMode("Custom")).toBe(0);
    });

    it("returns 2 for Wingman, Deathmatch", () => {
      const { service } = createService();
      const getGameMode = (service as any).getGameMode.bind(service);

      expect(getGameMode("Wingman")).toBe(2);
      expect(getGameMode("Deathmatch")).toBe(2);
    });
  });

  describe("getWarGameType (private)", () => {
    it("returns 12 for Retake", () => {
      const { service } = createService();
      expect((service as any).getWarGameType("Retake")).toBe(12);
    });

    it("returns 0 for other types", () => {
      const { service } = createService();
      const getWarGameType = (service as any).getWarGameType.bind(service);

      expect(getWarGameType("Ranked")).toBe(0);
      expect(getWarGameType("Competitive")).toBe(0);
      expect(getWarGameType("Deathmatch")).toBe(0);
    });
  });

  describe("getDedicatedServerDeploymentName (private)", () => {
    it("returns dedicated-server-{serverId}", () => {
      const { service } = createService();
      expect((service as any).getDedicatedServerDeploymentName("abc-123")).toBe(
        "dedicated-server-abc-123",
      );
    });
  });

  describe("getAllDedicatedServerStats", () => {
    it("returns empty array when redis has no data", async () => {
      const { service } = createService({
        redis: { hgetall: jest.fn().mockResolvedValue({}) },
      });

      const result = await service.getAllDedicatedServerStats();
      expect(result).toEqual([]);
    });

    it("returns empty array when hgetall returns null", async () => {
      const { service } = createService({
        redis: { hgetall: jest.fn().mockResolvedValue(null) },
      });

      const result = await service.getAllDedicatedServerStats();
      expect(result).toEqual([]);
    });

    it("parses valid server data from redis", async () => {
      const { service } = createService({
        redis: {
          hgetall: jest.fn().mockResolvedValue({
            "server-1": JSON.stringify({
              clients_human: 8,
              map: "de_dust2",
              last_ping: "2026-01-01T00:00:00Z",
            }),
            "server-2": JSON.stringify({
              clients_human: 0,
              map: "de_mirage",
              last_ping: "2026-01-01T00:01:00Z",
            }),
          }),
        },
      });

      const result = await service.getAllDedicatedServerStats();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "server-1",
        players: 8,
        map: "de_dust2",
        lastPing: "2026-01-01T00:00:00Z",
      });
      expect(result[1]).toEqual({
        id: "server-2",
        players: 0,
        map: "de_mirage",
        lastPing: "2026-01-01T00:01:00Z",
      });
    });

    it("filters out entries with malformed JSON", async () => {
      const { service } = createService({
        redis: {
          hgetall: jest.fn().mockResolvedValue({
            "server-1": "not-json",
            "server-2": JSON.stringify({
              clients_human: 5,
              map: "de_inferno",
              last_ping: "2026-01-01T00:00:00Z",
            }),
          }),
        },
      });

      const result = await service.getAllDedicatedServerStats();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("server-2");
    });

    it("returns empty array on redis error", async () => {
      const { service } = createService({
        redis: {
          hgetall: jest.fn().mockRejectedValue(new Error("Redis down")),
        },
      });

      const result = await service.getAllDedicatedServerStats();
      expect(result).toEqual([]);
    });
  });

  describe("restartDedicatedServer", () => {
    it("delegates to systemService.restartDeployment with correct args", async () => {
      const { service, systemService } = createService();

      await service.restartDedicatedServer("server-1");

      expect(systemService.restartDeployment).toHaveBeenCalledWith(
        "dedicated-server-server-1",
        "test-ns",
      );
    });
  });

  describe("pingDedicatedServer", () => {
    it("marks server as connected when not already connected", async () => {
      const rconSend = jest.fn().mockResolvedValue(
        JSON.stringify({
          server: {
            steamid: "steam-123",
            clients_human: 5,
            map: "de_dust2",
          },
        }),
      );
      const { service, hasura, redis } = createService({
        rcon: {
          connect: jest.fn().mockResolvedValue({ send: rconSend }),
          disconnect: jest.fn(),
        },
      });

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: {
          game: "cs2",
          connected: false,
          steam_relay: null,
          server_region: { steam_relay: true },
        },
      });

      await service.pingDedicatedServer("server-1");

      // Should update connected to true
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_servers_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              _set: expect.objectContaining({ connected: true }),
            }),
          }),
        }),
      );
    });

    it("stores stats in redis", async () => {
      const rconSend = jest.fn().mockResolvedValue(
        JSON.stringify({
          server: {
            steamid: null,
            clients_human: 3,
            map: "de_mirage",
          },
        }),
      );
      const { service, hasura, redis } = createService({
        rcon: {
          connect: jest.fn().mockResolvedValue({ send: rconSend }),
          disconnect: jest.fn(),
        },
      });

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: {
          game: "cs2",
          connected: true,
          steam_relay: null,
          server_region: { steam_relay: false },
        },
      });

      await service.pingDedicatedServer("server-1");

      expect(redis.hset).toHaveBeenCalledWith(
        "dedicated-servers:stats",
        "server-1",
        expect.stringContaining('"clients_human":3'),
      );
      expect(redis.expire).toHaveBeenCalledWith(
        "dedicated-servers:stats",
        120,
      );
    });

    it("handles csgo servers with status text parsing", async () => {
      const statusOutput =
        "map     : de_dust2\nplayers : 7 humans, 0 bots (10 max)";
      const rconSend = jest.fn().mockResolvedValue(statusOutput);
      const { service, hasura, redis } = createService({
        rcon: {
          connect: jest.fn().mockResolvedValue({ send: rconSend }),
          disconnect: jest.fn(),
        },
      });

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: {
          game: "csgo",
          connected: true,
          steam_relay: null,
          server_region: { steam_relay: false },
        },
      });

      await service.pingDedicatedServer("server-1");

      expect(redis.hset).toHaveBeenCalledWith(
        "dedicated-servers:stats",
        "server-1",
        expect.stringContaining('"clients_human":7'),
      );
    });

    it("disconnects rcon after ping", async () => {
      const rconSend = jest.fn().mockResolvedValue(
        JSON.stringify({
          server: { steamid: null, clients_human: 0, map: "de_dust2" },
        }),
      );
      const rcon = {
        connect: jest.fn().mockResolvedValue({ send: rconSend }),
        disconnect: jest.fn(),
      };
      const { service, hasura } = createService({ rcon });

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: {
          game: "cs2",
          connected: true,
          steam_relay: null,
          server_region: { steam_relay: false },
        },
      });

      await service.pingDedicatedServer("server-1");

      expect(rcon.disconnect).toHaveBeenCalledWith("server-1");
    });
  });
});
