jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { Logger, BadRequestException } from "@nestjs/common";
import { AuthController } from "./auth.controller";

function createController() {
  const cache = {
    get: jest.fn().mockResolvedValue(undefined),
  };
  const hasura = {
    mutation: jest.fn().mockResolvedValue({}),
  };
  const redisConnection = {
    del: jest.fn().mockResolvedValue(1),
  };
  const redis = {
    getConnection: jest.fn().mockReturnValue(redisConnection),
  };
  const apiKeys = {
    createApiKey: jest.fn().mockResolvedValue("generated-key-123"),
  };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  const controller = new AuthController(
    cache as any,
    hasura as any,
    redis as any,
    apiKeys as any,
    logger,
  );

  return { controller, cache, hasura, redis, redisConnection, apiKeys, logger };
}

function makeRequest(overrides: Record<string, any> = {}) {
  return {
    user: {
      steam_id: "76561198000000001",
      name: "TestPlayer",
      role: "user",
      discord_id: "discord-123",
      ...overrides.user,
    },
    session: {
      id: "session-id-1",
      save: jest.fn(),
      destroy: jest.fn((cb) => cb(null)),
      ...overrides.session,
    },
    ...overrides,
  } as any;
}

describe("AuthController", () => {
  describe("me", () => {
    it("returns user with cached name and role", async () => {
      const { controller, cache } = createController();

      cache.get
        .mockResolvedValueOnce("CachedName")
        .mockResolvedValueOnce("admin");

      const request = makeRequest();
      const result = await controller.me(request);

      expect(result.name).toBe("CachedName");
      expect(result.role).toBe("admin");
    });
  });

  describe("unlinkDiscord", () => {
    it("removes discord_id via Hasura mutation", async () => {
      const { controller, hasura } = createController();
      const request = makeRequest();

      await controller.unlinkDiscord(request);

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_players_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              pk_columns: { steam_id: "76561198000000001" },
              _set: { discord_id: null },
            }),
          }),
        }),
      );
    });

    it("clears discord_id from session user", async () => {
      const { controller } = createController();
      const request = makeRequest();

      await controller.unlinkDiscord(request);

      expect(request.user.discord_id).toBeNull();
      expect(request.session.save).toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("destroys session and deletes Redis latency key", async () => {
      const { controller, redisConnection } = createController();
      const request = makeRequest();

      await controller.logout(request);

      expect(redisConnection.del).toHaveBeenCalledWith(
        expect.stringContaining("session-id-1"),
      );
      expect(request.session.destroy).toHaveBeenCalled();
    });

    it("handles missing session gracefully", async () => {
      const { controller } = createController();
      const request = { session: null } as any;

      const result = await controller.logout(request);

      expect(result).toEqual({ success: true });
    });
  });

  describe("createApiKey", () => {
    it("throws BadRequestException when label is empty", async () => {
      const { controller } = createController();

      await expect(
        controller.createApiKey({
          user: { steam_id: "76561198000000001" } as any,
          label: "",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("returns key from ApiKeys service", async () => {
      const { controller, apiKeys } = createController();
      apiKeys.createApiKey.mockResolvedValueOnce("my-api-key");

      const result = await controller.createApiKey({
        user: { steam_id: "76561198000000001" } as any,
        label: "My Key",
      });

      expect(result).toEqual({ key: "my-api-key" });
      expect(apiKeys.createApiKey).toHaveBeenCalledWith(
        "My Key",
        "76561198000000001",
      );
    });
  });
});
