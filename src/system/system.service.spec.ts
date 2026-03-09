jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(),
  })),
  CoreV1Api: jest.fn(),
  AppsV1Api: jest.fn(),
  setHeaderOptions: jest.fn(),
  PatchStrategy: { StrategicMergePatch: "strategic-merge-patch" },
}));

import { Logger } from "@nestjs/common";
import { SystemService } from "./system.service";

function createService() {
  const cache = {
    has: jest.fn().mockResolvedValue(false),
    put: jest.fn().mockResolvedValue(undefined),
    forget: jest.fn().mockResolvedValue(undefined),
    remember: jest.fn(),
  };
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
  };
  const config = {
    get: jest.fn().mockReturnValue({}),
  };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;
  const postgres = {
    query: jest.fn().mockResolvedValue(undefined),
  };

  const service = new SystemService(
    cache as any,
    hasura as any,
    config as any,
    logger,
    postgres as any,
  );

  return { service, cache, hasura, config, logger, postgres };
}

describe("SystemService", () => {
  describe("getSetting", () => {
    it("returns string value from database", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([{ value: "hello" }]);

      const result = await service.getSetting("some_setting" as any, "default");

      expect(result).toBe("hello");
    });

    it("returns default when no row found", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([]);

      const result = await service.getSetting("missing" as any, "fallback");

      expect(result).toBe("fallback");
    });

    it("converts to boolean when default is boolean", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([{ value: "true" }]);

      const result = await service.getSetting("bool_setting" as any, false);

      expect(result).toBe(true);
    });

    it("returns false for non-true string when default is boolean", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([{ value: "no" }]);

      const result = await service.getSetting("bool_setting" as any, true);

      expect(result).toBe(false);
    });

    it("converts to number when default is number", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([{ value: "42" }]);

      const result = await service.getSetting("num_setting" as any, 0);

      expect(result).toBe(42);
    });

    it("returns default when value is NaN and default is number", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([{ value: "not-a-number" }]);

      const result = await service.getSetting("num_setting" as any, 99);

      expect(result).toBe(99);
    });

    it("returns default when value is null", async () => {
      const { service, postgres } = createService();
      postgres.query.mockResolvedValueOnce([{ value: null }]);

      const result = await service.getSetting("setting" as any, "default");

      expect(result).toBe("default");
    });
  });

  describe("updateDefaultOptions", () => {
    it("sets default_models to true when setting is true", async () => {
      const { service, hasura, postgres } = createService();

      hasura.query.mockResolvedValueOnce({
        settings: [{ name: "public.default_models", value: "true" }],
      });

      await service.updateDefaultOptions();

      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("default_models"),
      );
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("true"),
      );
    });

    it("sets default_models to false when setting is not true", async () => {
      const { service, hasura, postgres } = createService();

      hasura.query.mockResolvedValueOnce({
        settings: [{ name: "public.default_models", value: "false" }],
      });

      await service.updateDefaultOptions();

      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("false"),
      );
    });

    it("does nothing for unrecognized settings", async () => {
      const { service, hasura, postgres } = createService();

      hasura.query.mockResolvedValueOnce({
        settings: [{ name: "some_other_setting", value: "abc" }],
      });

      await service.updateDefaultOptions();

      expect(postgres.query).not.toHaveBeenCalled();
    });
  });
});
