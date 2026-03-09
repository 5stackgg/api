jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { RconService } from "./rcon.service";

function createService() {
  const hasuraService = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
  };
  const encryption = { decrypt: jest.fn().mockResolvedValue("password") };
  const notifications = { send: jest.fn() };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;
  const typeSenseService = {
    resetCvars: jest.fn(),
    upsertCvars: jest.fn(),
  };
  const redisConnection = {
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
  };
  const redisManager = {
    getConnection: jest.fn().mockReturnValue(redisConnection),
  };
  const cache = {
    has: jest.fn().mockResolvedValue(false),
    put: jest.fn().mockResolvedValue(undefined),
    forget: jest.fn().mockResolvedValue(undefined),
  };

  const service = new RconService(
    hasuraService as any,
    encryption as any,
    notifications as any,
    logger,
    typeSenseService as any,
    redisManager as any,
    cache as any,
  );

  return {
    service,
    hasuraService,
    logger,
    redisConnection,
    redisManager,
    cache,
  };
}

describe("RconService", () => {
  describe("parseCvarList", () => {
    it("parses standard 4-column cvar output", () => {
      const { service } = createService();
      const output = [
        "cvar list",
        "-------------------------------------------",
        "  sv_cheats : cmd : , \"sv\" : Allow cheats on server",
        "  mp_autoteambalance : cmd : , \"sv\" : Auto team balance",
        "-------------------------------------------",
        "2 convars/concommands for [s]",
      ].join("\n");

      const result = (service as any).parseCvarList(output);

      expect(result).toEqual([
        {
          name: "sv_cheats",
          kind: "cmd",
          flags: ', "sv"',
          description: "Allow cheats on server",
        },
        {
          name: "mp_autoteambalance",
          kind: "cmd",
          flags: ', "sv"',
          description: "Auto team balance",
        },
      ]);
    });

    it("skips empty lines and header/footer lines", () => {
      const { service } = createService();
      const output = [
        "",
        "cvar list",
        "-------------------------------------------",
        "",
        "  some_cvar : cmd : flags : desc",
        "",
        "1 convars/concommands for [A]",
      ].join("\n");

      const result = (service as any).parseCvarList(output);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("some_cvar");
    });

    it("skips noisy status lines", () => {
      const { service } = createService();
      const output = [
        "watching for changes...",
        "list : something",
        "  real_cvar : cmd : flags : description here",
      ].join("\n");

      const result = (service as any).parseCvarList(output);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("real_cvar");
    });

    it("handles empty description", () => {
      const { service } = createService();
      const output = "  my_cvar : cmd : sv : ";

      const result = (service as any).parseCvarList(output);

      expect(result).toEqual([
        { name: "my_cvar", kind: "cmd", flags: "sv", description: "" },
      ]);
    });

    it("logs warning for unparseable lines", () => {
      const { service, logger } = createService();
      const output = "this line has no colons at all";

      const result = (service as any).parseCvarList(output);

      expect(result).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unable to parse cvar list"),
      );
    });

    it("returns empty array for empty input", () => {
      const { service } = createService();

      const result = (service as any).parseCvarList("");

      expect(result).toEqual([]);
    });
  });

  describe("disconnect", () => {
    it("ends connection and cleans up when connection exists", async () => {
      const { service } = createService();
      const mockEnd = jest.fn();

      // Inject a fake connection
      (service as any).connections["server-1"] = { end: mockEnd };
      (service as any).connectTimeouts["server-1"] = setTimeout(() => {}, 10000);

      await service.disconnect("server-1");

      expect(mockEnd).toHaveBeenCalled();
      expect((service as any).connections["server-1"]).toBeUndefined();
      expect((service as any).connectTimeouts["server-1"]).toBeUndefined();
    });

    it("does nothing when no connection exists", async () => {
      const { service } = createService();

      await service.disconnect("nonexistent");

      expect((service as any).connections["nonexistent"]).toBeUndefined();
    });
  });

  describe("lock methods", () => {
    it("aquireCvarsLock returns true when lock acquired", async () => {
      const { service, redisConnection } = createService();
      redisConnection.set.mockResolvedValueOnce("OK");

      const result = await (service as any).aquireCvarsLock("12345");

      expect(result).toBe(true);
      expect(redisConnection.set).toHaveBeenCalledWith(
        "cvars:lock:12345",
        1,
        "EX",
        60,
        "NX",
      );
    });

    it("aquireCvarsLock returns false when lock already held", async () => {
      const { service, redisConnection } = createService();
      redisConnection.set.mockResolvedValueOnce(null);

      const result = await (service as any).aquireCvarsLock("12345");

      expect(result).toBe(false);
    });

    it("releaseCvarsLock deletes the lock key", async () => {
      const { service, redisConnection } = createService();

      await (service as any).releaseCvarsLock("12345");

      expect(redisConnection.del).toHaveBeenCalledWith("cvars:lock:12345");
    });

    it("aquirePrefixLock returns true when lock acquired", async () => {
      const { service, redisConnection } = createService();
      redisConnection.set.mockResolvedValueOnce("OK");

      const result = await (service as any).aquirePrefixLock("12345", "A");

      expect(result).toBe(true);
      expect(redisConnection.set).toHaveBeenCalledWith(
        "cvars:lock:12345:A",
        1,
        "EX",
        60,
        "NX",
      );
    });

    it("releasePrefixLock deletes the lock key", async () => {
      const { service, redisConnection } = createService();

      await (service as any).releasePrefixLock("12345", "A");

      expect(redisConnection.del).toHaveBeenCalledWith("cvars:lock:12345:A");
    });
  });
});
