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

  describe("assignServer", () => {
    it("assigns dedicated server when prefer_dedicated_server and available", async () => {
      const { service, hasura } = createService();

      // First call: get match options
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: {
          id: "m1",
          region: "eu-west",
          options: { prefer_dedicated_server: true },
        },
      });
      // Second call: find available dedicated server
      hasura.query.mockResolvedValueOnce({
        servers: [{ id: "server-1" }],
      });

      await service.assignServer("m1");

      // Should assign server and set match to Live
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_matches_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              _set: expect.objectContaining({ server_id: "server-1" }),
            }),
          }),
        }),
      );
    });

    it("sets WaitingForServer when prefer_dedicated but none available and on-demand fails", async () => {
      const { service, hasura } = createService();

      // Match with prefer_dedicated_server
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: {
          id: "m1",
          region: "eu-west",
          options: { prefer_dedicated_server: true },
        },
      });
      // No dedicated servers available
      hasura.query.mockResolvedValueOnce({ servers: [] });
      // On-demand: match query
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: {
          region: "eu-west",
          password: "pw",
          server_id: null,
          max_players_per_lineup: 5,
          match_maps: [{ map: { name: "de_dust2", workshop_map_id: null }, order: 1 }],
        },
      });
      // No game server nodes available
      hasura.query.mockResolvedValueOnce({ game_server_nodes: [] });

      await service.assignServer("m1");

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_matches_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              _set: { status: "WaitingForServer" },
            }),
          }),
        }),
      );
    });
  });

  describe("isDedicatedServerAvailable", () => {
    it("throws when match has no server", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { server: null },
      });

      await expect(service.isDedicatedServerAvailable("m1")).rejects.toThrow(
        "match has no server assigned",
      );
    });
  });

  describe("getAvailableMaps", () => {
    it("filters out banned and picked maps", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: {
          options: {
            map_pool: {
              maps: [
                { id: "map1", name: "de_dust2" },
                { id: "map2", name: "de_mirage" },
                { id: "map3", name: "de_inferno" },
              ],
            },
          },
          map_veto_picks: [{ map_id: "map1" }],
        },
      });

      const available = await service.getAvailableMaps("m1");
      expect(available).toHaveLength(2);
      expect(available.map((m) => m.id)).toEqual(["map2", "map3"]);
    });

    it("throws when map pool not found", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: { options: { map_pool: null }, map_veto_picks: [] },
      });

      await expect(service.getAvailableMaps("m1")).rejects.toThrow(
        "unable to find match maps",
      );
    });
  });
});
