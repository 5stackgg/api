import { Logger } from "@nestjs/common";
import { CacheService } from "./cache.service";
import {
  createMockRedisConnection,
  createMockRedisManager,
} from "../test-helpers/mock-redis";

function createCacheService() {
  const connection = createMockRedisConnection();
  const redisManager = createMockRedisManager(connection);
  const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Logger;
  const service = new CacheService(redisManager as any, logger);
  return { service, connection, logger };
}

describe("CacheService", () => {
  describe("get", () => {
    it("returns parsed JSON from redis", async () => {
      const { service, connection } = createCacheService();
      connection._store.set("key1", JSON.stringify({ a: 1 }));

      const result = await service.get("key1");
      expect(result).toEqual({ a: 1 });
    });

    it("returns defaultValue when key does not exist", async () => {
      const { service } = createCacheService();
      const result = await service.get("missing", "fallback");
      expect(result).toBe("fallback");
    });

    it("returns undefined when key missing and no default", async () => {
      const { service } = createCacheService();
      const result = await service.get("missing");
      expect(result).toBeUndefined();
    });
  });

  describe("has", () => {
    it("returns true when key exists", async () => {
      const { service, connection } = createCacheService();
      connection._store.set("exists", JSON.stringify("val"));
      expect(await service.has("exists")).toBe(true);
    });

    it("returns false when key is missing", async () => {
      const { service } = createCacheService();
      expect(await service.has("nope")).toBe(false);
    });
  });

  describe("put", () => {
    it("stores JSON-stringified value", async () => {
      const { service, connection } = createCacheService();
      await service.put("k", { hello: "world" });
      expect(connection._store.get("k")).toBe(JSON.stringify({ hello: "world" }));
    });

    it("sets expiry when seconds provided", async () => {
      const { service, connection } = createCacheService();
      await service.put("k", "v", 300);
      expect(connection.expire).toHaveBeenCalledWith("k", 300);
    });

    it("does not set expiry when no seconds", async () => {
      const { service, connection } = createCacheService();
      await service.put("k", "v");
      expect(connection.expire).not.toHaveBeenCalled();
    });

    it("returns false and logs on error", async () => {
      const { service, connection, logger } = createCacheService();
      connection.set.mockRejectedValueOnce(new Error("redis down"));
      const result = await service.put("k", "v");
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("forget", () => {
    it("deletes key from redis", async () => {
      const { service, connection } = createCacheService();
      connection._store.set("k", "v");
      const result = await service.forget("k");
      expect(result).toBe(true);
      expect(connection.del).toHaveBeenCalledWith("k");
    });

    it("returns false and logs on error", async () => {
      const { service, connection, logger } = createCacheService();
      connection.del.mockRejectedValueOnce(new Error("redis down"));
      const result = await service.forget("k");
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("remember", () => {
    it("returns cached value without calling callback", async () => {
      const { service, connection } = createCacheService();
      connection._store.set("k", JSON.stringify("cached"));
      const cb = jest.fn().mockResolvedValue("fresh");

      const result = await service.remember("k", cb, 60);
      expect(result).toBe("cached");
      expect(cb).not.toHaveBeenCalled();
    });

    it("calls callback and stores result when key missing", async () => {
      const { service, connection } = createCacheService();
      const cb = jest.fn().mockResolvedValue("fresh");

      const result = await service.remember("k", cb, 60);
      expect(result).toBe("fresh");
      expect(cb).toHaveBeenCalled();
      expect(connection._store.get("k")).toBe(JSON.stringify("fresh"));
    });

    it("does not store undefined callback result", async () => {
      const { service, connection } = createCacheService();
      const cb = jest.fn().mockResolvedValue(undefined);

      await service.remember("k", cb, 60);
      expect(connection._store.has("k")).toBe(false);
    });
  });

  describe("rememberForever", () => {
    it("stores without TTL", async () => {
      const { service, connection } = createCacheService();
      const cb = jest.fn().mockResolvedValue("forever");

      const result = await service.rememberForever("k", cb);
      expect(result).toBe("forever");
      expect(connection.expire).not.toHaveBeenCalled();
    });
  });

  describe("lock", () => {
    it("acquires lock, runs callback, releases lock", async () => {
      const { service, connection } = createCacheService();
      const cb = jest.fn().mockResolvedValue("result");

      const result = await service.lock("resource", cb, 30);
      expect(result).toBe("result");
      expect(connection.set).toHaveBeenCalledWith(
        "lock:resource",
        1,
        "EX",
        30,
        "NX",
      );
      expect(connection.del).toHaveBeenCalledWith("lock:resource");
    });

    it("releases lock even if callback throws", async () => {
      const { service, connection } = createCacheService();
      const cb = jest.fn().mockRejectedValue(new Error("boom"));

      await expect(service.lock("resource", cb)).rejects.toThrow("boom");
      expect(connection.del).toHaveBeenCalledWith("lock:resource");
    });

    it("retries when lock is held", async () => {
      jest.useFakeTimers();
      const { service, connection } = createCacheService();
      const cb = jest.fn().mockResolvedValue("ok");

      // First call: lock held (NX fails). Second call: lock acquired.
      connection.set
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("OK");

      const promise = service.lock("resource", cb);

      // Advance past the 100ms retry delay
      await jest.advanceTimersByTimeAsync(100);

      const result = await promise;
      expect(result).toBe("ok");
      expect(connection.set).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });
  });

  describe("tags", () => {
    it("returns a CacheTag instance", () => {
      const { service } = createCacheService();
      const tag = service.tags(["user", "123"]);
      expect(tag).toBeDefined();
      expect(tag.get).toBeDefined();
      expect(tag.put).toBeDefined();
      expect(tag.forget).toBeDefined();
    });
  });
});
