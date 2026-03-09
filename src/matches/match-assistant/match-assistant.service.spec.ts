jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { MatchAssistantService } from "./match-assistant.service";

function createService(hasuraOverrides: Record<string, any> = {}) {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
    ...hasuraOverrides,
  };

  const rcon = { connect: jest.fn(), disconnect: jest.fn() };
  const cache = { lock: jest.fn() };
  const config = {
    get: jest.fn((key: string) => {
      if (key === "app") return { apiDomain: "api.test", relayDomain: "relay.test", demosDomain: "demos.test", wsDomain: "ws.test" };
      if (key === "gameServers") return { namespace: "test-ns", serverImage: "img:latest" };
      return {};
    }),
  };
  const encryption = { decrypt: jest.fn().mockResolvedValue("decrypted") };
  const queue = { add: jest.fn(), remove: jest.fn() };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn(), verbose: jest.fn() } as unknown as Logger;

  const service = new MatchAssistantService(
    logger,
    rcon as any,
    cache as any,
    config as any,
    hasura as any,
    encryption as any,
    queue as any,
  );

  return { service, hasura };
}

const testUser = { steam_id: "test-steam-id" } as any;

describe("MatchAssistantService", () => {
  describe("GetMatchServerJobId", () => {
    it("returns job name prefixed with m-", () => {
      expect(MatchAssistantService.GetMatchServerJobId("abc-123")).toBe("m-abc-123");
    });
  });

  describe("canSchedule", () => {
    it("returns true when Hasura says can_schedule is true", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { can_schedule: true },
      });

      const result = await service.canSchedule("match-1", testUser);
      expect(result).toBe(true);
      expect(hasura.query).toHaveBeenCalledWith(
        expect.objectContaining({
          matches_by_pk: expect.objectContaining({ can_schedule: true }),
        }),
        "test-steam-id",
      );
    });

    it("returns false when Hasura says can_schedule is false", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { can_schedule: false },
      });

      expect(await service.canSchedule("match-1", testUser)).toBe(false);
    });
  });

  describe("canCancel", () => {
    it("returns true when match can be cancelled", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { can_cancel: true },
      });

      expect(await service.canCancel("match-1", testUser)).toBe(true);
    });

    it("returns false when match cannot be cancelled", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { can_cancel: false },
      });

      expect(await service.canCancel("match-1", testUser)).toBe(false);
    });
  });

  describe("canStart", () => {
    it("returns true when match can be started", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { can_start: true },
      });

      expect(await service.canStart("match-1", testUser)).toBe(true);
    });

    it("returns false when match cannot be started", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { can_start: false },
      });

      expect(await service.canStart("match-1", testUser)).toBe(false);
    });
  });

  describe("isOrganizer", () => {
    it("returns true for match organizer", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { is_organizer: true },
      });

      expect(await service.isOrganizer("match-1", testUser)).toBe(true);
    });

    it("returns false for non-organizer", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { is_organizer: false },
      });

      expect(await service.isOrganizer("match-1", testUser)).toBe(false);
    });

    it("passes user steam_id to Hasura query", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { is_organizer: false },
      });

      await service.isOrganizer("match-1", testUser);

      expect(hasura.query).toHaveBeenCalledWith(
        expect.anything(),
        "test-steam-id",
      );
    });
  });

  describe("updateMatchStatus", () => {
    it("sends mutation with correct status", async () => {
      const { service, hasura } = createService();
      hasura.mutation.mockResolvedValueOnce({ update_matches_by_pk: { id: "m1" } });

      await service.updateMatchStatus("m1", "Live");

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_matches_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              _set: { status: "Live" },
            }),
          }),
        }),
      );
    });
  });
});
