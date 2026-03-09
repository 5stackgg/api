jest.mock("../../generated", () => ({
  createClient: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { HasuraService } from "./hasura.service";
import { createClient } from "../../generated";
import crypto from "crypto";

const mockedCreateClient = createClient as jest.MockedFunction<
  typeof createClient
>;

function createService(overrides?: { secret?: string }) {
  const cache = {
    remember: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
    forget: jest.fn(),
  };

  const config = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === "hasura") {
        return {
          endpoint: "http://hasura:8080",
          secret: overrides?.secret ?? "test-secret",
        };
      }
      if (key === "app") {
        return {
          demosDomain: "demos.example.com",
          relayDomain: "relay.example.com",
        };
      }
      return {};
    }),
  };

  const postgres = {
    query: jest.fn().mockResolvedValue([]),
  };

  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    verbose: jest.fn(),
  } as unknown as Logger;

  const service = new HasuraService(
    logger,
    cache as any,
    config as any,
    postgres as any,
  );

  return { service, cache, config, postgres, logger };
}

describe("HasuraService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("PLAYER_NAME_CACHE_KEY", () => {
    it("returns correct format for string steamId", () => {
      expect(HasuraService.PLAYER_NAME_CACHE_KEY("12345")).toBe(
        "user:name:12345",
      );
    });

    it("returns correct format for bigint steamId", () => {
      expect(HasuraService.PLAYER_NAME_CACHE_KEY(BigInt(99999))).toBe(
        "user:name:99999",
      );
    });
  });

  describe("PLAYER_ROLE_CACHE_KEY", () => {
    it("returns correct format for string steamId", () => {
      expect(HasuraService.PLAYER_ROLE_CACHE_KEY("12345")).toBe(
        "user:role:12345",
      );
    });

    it("returns correct format for bigint steamId", () => {
      expect(HasuraService.PLAYER_ROLE_CACHE_KEY(BigInt(99999))).toBe(
        "user:role:99999",
      );
    });
  });

  describe("checkSecret", () => {
    it("returns true when secret matches", () => {
      const { service } = createService({ secret: "my-secret" });
      expect(service.checkSecret("my-secret")).toBe(true);
    });

    it("returns false when secret does not match", () => {
      const { service } = createService({ secret: "my-secret" });
      expect(service.checkSecret("wrong-secret")).toBe(false);
    });

    it("returns false for empty string", () => {
      const { service } = createService({ secret: "my-secret" });
      expect(service.checkSecret("")).toBe(false);
    });
  });

  describe("calcSqlDigest", () => {
    it("returns a sha256 base64 digest for string input", () => {
      const { service } = createService();
      const result = service.calcSqlDigest("SELECT 1");

      const expected = crypto
        .createHash("sha256")
        .update("SELECT 1")
        .digest("base64");
      expect(result).toBe(expected);
    });

    it("returns a sha256 base64 digest for array input", () => {
      const { service } = createService();
      const result = service.calcSqlDigest(["SELECT 1", "SELECT 2"]);

      const expected = crypto
        .createHash("sha256")
        .update("SELECT 1")
        .update("SELECT 2")
        .digest("base64");
      expect(result).toBe(expected);
    });

    it("returns consistent results for same input", () => {
      const { service } = createService();
      const result1 = service.calcSqlDigest("CREATE TABLE foo()");
      const result2 = service.calcSqlDigest("CREATE TABLE foo()");
      expect(result1).toBe(result2);
    });

    it("returns different results for different input", () => {
      const { service } = createService();
      const result1 = service.calcSqlDigest("SELECT 1");
      const result2 = service.calcSqlDigest("SELECT 2");
      expect(result1).not.toBe(result2);
    });
  });

  describe("getHasuraHeaders", () => {
    it("returns correct headers with cached role", async () => {
      const { service, cache } = createService();
      cache.remember.mockImplementation(
        async (_key: string, cb: () => Promise<string>) => {
          return await cb();
        },
      );

      // Mock the internal query call via createClient
      const mockQuery = jest.fn().mockResolvedValue({
        players_by_pk: { role: "user" },
      });
      mockedCreateClient.mockReturnValue({
        query: mockQuery,
        mutation: jest.fn(),
      } as any);

      const headers = await service.getHasuraHeaders("76561198000000001");

      expect(headers).toEqual({
        "x-hasura-role": "user",
        "x-hasura-user-id": "76561198000000001",
      });
    });

    it("uses the PLAYER_ROLE_CACHE_KEY", async () => {
      const { service, cache } = createService();
      cache.remember.mockResolvedValue("admin");

      const headers = await service.getHasuraHeaders("76561198000000001");

      expect(cache.remember).toHaveBeenCalledWith(
        "user:role:76561198000000001",
        expect.any(Function),
        60 * 60 * 1000,
      );
      expect(headers).toEqual({
        "x-hasura-role": "admin",
        "x-hasura-user-id": "76561198000000001",
      });
    });
  });

  describe("query", () => {
    it("delegates to createClient and returns the result", async () => {
      const { service } = createService();
      const mockQuery = jest
        .fn()
        .mockResolvedValue({ players: [{ id: "1" }] });
      mockedCreateClient.mockReturnValue({
        query: mockQuery,
        mutation: jest.fn(),
      } as any);

      const result = await service.query({ players: { id: true } } as any);

      expect(result).toEqual({ players: [{ id: "1" }] });
    });

    it("throws the first error message when response has errors", async () => {
      const { service } = createService();
      const error = {
        response: {
          errors: [{ message: "permission denied" }],
        },
      };
      const mockQuery = jest.fn().mockRejectedValue(error);
      mockedCreateClient.mockReturnValue({
        query: mockQuery,
        mutation: jest.fn(),
      } as any);

      await expect(
        service.query({ players: { id: true } } as any),
      ).rejects.toBe("permission denied");
    });

    it("rethrows non-response errors", async () => {
      const { service } = createService();
      const error = new Error("network failure");
      const mockQuery = jest.fn().mockRejectedValue(error);
      mockedCreateClient.mockReturnValue({
        query: mockQuery,
        mutation: jest.fn(),
      } as any);

      await expect(
        service.query({ players: { id: true } } as any),
      ).rejects.toThrow("network failure");
    });
  });

  describe("mutation", () => {
    it("delegates to createClient and returns the result", async () => {
      const { service } = createService();
      const mockMutation = jest
        .fn()
        .mockResolvedValue({ insert_players_one: { id: "1" } });
      mockedCreateClient.mockReturnValue({
        query: jest.fn(),
        mutation: mockMutation,
      } as any);

      const result = await service.mutation({
        insert_players_one: { __args: {} },
      } as any);

      expect(result).toEqual({ insert_players_one: { id: "1" } });
    });

    it("throws the first error message when response has errors", async () => {
      const { service } = createService();
      const error = {
        response: {
          errors: [
            { message: "unique constraint violated" },
            { message: "second error" },
          ],
        },
      };
      const mockMutation = jest.fn().mockRejectedValue(error);
      mockedCreateClient.mockReturnValue({
        query: jest.fn(),
        mutation: mockMutation,
      } as any);

      await expect(
        service.mutation({ insert_players_one: { __args: {} } } as any),
      ).rejects.toBe("unique constraint violated");
    });

    it("rethrows non-response errors", async () => {
      const { service } = createService();
      const error = new Error("timeout");
      const mockMutation = jest.fn().mockRejectedValue(error);
      mockedCreateClient.mockReturnValue({
        query: jest.fn(),
        mutation: mockMutation,
      } as any);

      await expect(
        service.mutation({ insert_players_one: { __args: {} } } as any),
      ).rejects.toThrow("timeout");
    });
  });

  describe("getSetting", () => {
    it("returns the hash value from postgres", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([{ hash: "abc123" }]);

      const result = await service.getSetting("my_setting");

      expect(result).toBe("abc123");
      expect(postgres.query).toHaveBeenCalledWith(
        "SELECT hash FROM migration_hashes.hashes WHERE name = $1",
        ["my_setting"],
      );
    });

    it("returns undefined when no row found", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([]);

      const result = await service.getSetting("missing");

      expect(result).toBeUndefined();
    });

    it("wraps errors with context", async () => {
      const { service, postgres } = createService();
      postgres.query.mockRejectedValueOnce(new Error("connection lost"));

      await expect(service.getSetting("my_setting")).rejects.toThrow(
        "unable to get setting my_setting: connection lost",
      );
    });
  });

  describe("setSetting", () => {
    it("inserts or updates the hash in postgres", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce(undefined);

      await service.setSetting("my_setting", "digest123");

      expect(postgres.query).toHaveBeenCalledWith(
        "insert into migration_hashes.hashes (name, hash) values ($1, $2) on conflict (name) do update set hash = $2",
        ["my_setting", "digest123"],
      );
    });

    it("wraps errors with context", async () => {
      const { service, postgres } = createService();
      postgres.query.mockRejectedValueOnce(new Error("disk full"));

      await expect(
        service.setSetting("my_setting", "digest123"),
      ).rejects.toThrow("unable to set setting my_setting: disk full");
    });
  });

  describe("apply", () => {
    const fs = require("fs");
    const path = require("path");

    beforeEach(() => {
      jest.spyOn(fs, "statSync");
      jest.spyOn(fs, "readdirSync");
      jest.spyOn(fs, "readFileSync");
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("recurses into directories", async () => {
      const { service, postgres } = createService();

      (fs.statSync as jest.Mock)
        .mockReturnValueOnce({ isDirectory: () => true })
        .mockReturnValueOnce({ isDirectory: () => false })
        .mockReturnValueOnce({ isDirectory: () => false });

      (fs.readdirSync as jest.Mock).mockReturnValueOnce(["a.sql", "b.sql"]);
      (fs.readFileSync as jest.Mock).mockReturnValue("SELECT 1");

      // getSetting returns matching digest for both files to skip apply
      const digest = service.calcSqlDigest("SELECT 1");
      postgres.query
        .mockResolvedValueOnce([{ hash: digest }])
        .mockResolvedValueOnce([{ hash: digest }]);

      await service.apply("/some/dir");

      expect(fs.readdirSync).toHaveBeenCalledWith("/some/dir");
      expect(fs.statSync).toHaveBeenCalledWith(
        path.join("/some/dir", "a.sql"),
      );
      expect(fs.statSync).toHaveBeenCalledWith(
        path.join("/some/dir", "b.sql"),
      );
    });

    it("skips file when digest matches", async () => {
      const { service, postgres, logger } = createService();

      (fs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as jest.Mock).mockReturnValue("SELECT 1");

      const digest = service.calcSqlDigest("SELECT 1");
      // getSetting returns the same digest
      postgres.query.mockResolvedValueOnce([{ hash: digest }]);

      await service.apply("/some/dir/my_func.sql");

      // Only the getSetting query, no exec query and no setSetting query
      expect(postgres.query).toHaveBeenCalledTimes(1);
      expect((logger as any).log).not.toHaveBeenCalled();
    });

    it("applies file when digest differs", async () => {
      const { service, postgres, logger } = createService();

      (fs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as jest.Mock).mockReturnValue("CREATE FUNCTION foo()");

      // getSetting returns a different digest
      postgres.query.mockResolvedValueOnce([{ hash: "old-digest" }]);
      // exec sql
      postgres.query.mockResolvedValueOnce(undefined);
      // setSetting
      postgres.query.mockResolvedValueOnce(undefined);

      await service.apply("/some/dir/my_func.sql");

      // getSetting + exec + setSetting = 3 calls
      expect(postgres.query).toHaveBeenCalledTimes(3);
      expect(postgres.query).toHaveBeenCalledWith(
        "begin;CREATE FUNCTION foo();commit;",
      );
      expect((logger as any).log).toHaveBeenCalledWith(
        "    applying my_func.sql",
      );
    });

    it("applies file when no prior setting exists", async () => {
      const { service, postgres } = createService();

      (fs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as jest.Mock).mockReturnValue(
        "INSERT INTO tbl VALUES (1)",
      );

      // getSetting returns no rows
      postgres.query.mockResolvedValueOnce([]);
      // exec sql
      postgres.query.mockResolvedValueOnce(undefined);
      // setSetting
      postgres.query.mockResolvedValueOnce(undefined);

      await service.apply("/some/dir/seed.sql");

      expect(postgres.query).toHaveBeenCalledTimes(3);
    });

    it("throws with context when sql execution fails", async () => {
      const { service, postgres } = createService();

      (fs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as jest.Mock).mockReturnValue("BAD SQL");

      // getSetting returns no rows
      postgres.query.mockResolvedValueOnce([]);
      // exec sql fails
      postgres.query.mockRejectedValueOnce(new Error("syntax error"));

      await expect(service.apply("/some/dir/bad.sql")).rejects.toThrow(
        "failed to exec sql bad.sql: syntax error",
      );
    });
  });
});
