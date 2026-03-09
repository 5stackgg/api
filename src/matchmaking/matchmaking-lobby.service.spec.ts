jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

jest.mock("uuid", () => ({
  validate: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { validate as validateUUID } from "uuid";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { PlayerLobby } from "./types/PlayerLobby";
import { JoinQueueError } from "./utilities/joinQueueError";
import { User } from "../auth/types/User";
import {
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";

const mockValidateUUID = validateUUID as jest.MockedFunction<
  typeof validateUUID
>;

function createService(hasuraOverrides: Record<string, jest.Mock> = {}) {
  const mockRedis = {
    hset: jest.fn().mockResolvedValue(1),
    hget: jest.fn().mockResolvedValue(null),
    hdel: jest.fn().mockResolvedValue(1),
    zrank: jest.fn().mockResolvedValue(0),
    zrange: jest.fn().mockResolvedValue([]),
    zrem: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
  };

  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
    ...hasuraOverrides,
  };

  const redisManager = { getConnection: jest.fn().mockReturnValue(mockRedis) };
  const matchmaking = {
    sendRegionStats: jest.fn(),
    getMatchConfirmationDetails: jest.fn(),
    removeConfirmationDetails: jest.fn(),
  };
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const service = new MatchmakingLobbyService(
    logger,
    hasura as any,
    redisManager as any,
    matchmaking as any,
  );

  return { service, hasura, mockRedis, matchmaking };
}

function makeUser(steamId = "captain-steam"): User {
  return { steam_id: steamId } as User;
}

function makeLobby(
  playerCount: number,
  captainId = "captain-steam",
): PlayerLobby {
  const players = Array.from({ length: playerCount }, (_, i) => ({
    captain: i === 0,
    name: `Player ${i}`,
    steam_id: i === 0 ? captainId : `steam-${i}`,
    is_banned: false,
    matchmaking_cooldown: false,
  }));
  return { id: "lobby-1", players };
}

function mockVerifyPlayerOk(hasura: any) {
  hasura.query.mockResolvedValue({
    players_by_pk: {
      name: "Player",
      steam_id: "any",
      is_banned: false,
      matchmaking_cooldown: false,
      current_lobby_id: null,
      is_in_another_match: false,
    },
  });
}

describe("MatchmakingLobbyService", () => {
  beforeEach(() => {
    mockValidateUUID.mockReset();
  });

  describe("verifyLobby - captain check", () => {
    it("throws when user is not the captain", async () => {
      const { service } = createService();
      const lobby = makeLobby(3, "other-captain");

      await expect(
        service.verifyLobby(lobby, makeUser("not-captain"), "Competitive"),
      ).rejects.toThrow(JoinQueueError);
    });

    it("accepts when user is the captain", async () => {
      const { service, hasura } = createService();
      const lobby = makeLobby(3);
      mockVerifyPlayerOk(hasura);

      await expect(
        service.verifyLobby(lobby, makeUser(), "Competitive"),
      ).resolves.toBe(true);
    });
  });

  describe("verifyLobby - Competitive team sizes", () => {
    it("accepts 1-5 players", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      for (const count of [1, 3, 5]) {
        await expect(
          service.verifyLobby(makeLobby(count), makeUser(), "Competitive"),
        ).resolves.toBe(true);
      }
    });

    it("accepts exactly 10 players", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      await expect(
        service.verifyLobby(makeLobby(10), makeUser(), "Competitive"),
      ).resolves.toBe(true);
    });

    it("rejects 6-9 players", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      for (const count of [6, 7, 8, 9]) {
        await expect(
          service.verifyLobby(makeLobby(count), makeUser(), "Competitive"),
        ).rejects.toThrow(JoinQueueError);
      }
    });
  });

  describe("verifyLobby - Wingman team sizes", () => {
    it("accepts 1-2 players", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      for (const count of [1, 2]) {
        await expect(
          service.verifyLobby(makeLobby(count), makeUser(), "Wingman"),
        ).resolves.toBe(true);
      }
    });

    it("accepts exactly 4 players", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      await expect(
        service.verifyLobby(makeLobby(4), makeUser(), "Wingman"),
      ).resolves.toBe(true);
    });

    it("rejects 3 players", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      await expect(
        service.verifyLobby(makeLobby(3), makeUser(), "Wingman"),
      ).rejects.toThrow(JoinQueueError);
    });
  });

  describe("verifyLobby - Duel team sizes", () => {
    it("accepts 1 player", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      await expect(
        service.verifyLobby(makeLobby(1), makeUser(), "Duel"),
      ).resolves.toBe(true);
    });

    it("accepts exactly 2 players", async () => {
      const { service, hasura } = createService();
      mockVerifyPlayerOk(hasura);

      await expect(
        service.verifyLobby(makeLobby(2), makeUser(), "Duel"),
      ).resolves.toBe(true);
    });
  });

  describe("verifyLobby - player verification", () => {
    it("rejects banned player", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValue({
        players_by_pk: {
          name: "Banned",
          steam_id: "captain-steam",
          is_banned: true,
          matchmaking_cooldown: false,
          current_lobby_id: null,
          is_in_another_match: false,
        },
      });

      await expect(
        service.verifyLobby(makeLobby(1), makeUser(), "Competitive"),
      ).rejects.toThrow("is banned");
    });

    it("rejects player with matchmaking cooldown", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValue({
        players_by_pk: {
          name: "Cooled",
          steam_id: "captain-steam",
          is_banned: false,
          matchmaking_cooldown: true,
          current_lobby_id: null,
          is_in_another_match: false,
        },
      });

      await expect(
        service.verifyLobby(makeLobby(1), makeUser(), "Competitive"),
      ).rejects.toThrow("cooldown");
    });

    it("rejects player already in another match", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValue({
        players_by_pk: {
          name: "InMatch",
          steam_id: "captain-steam",
          is_banned: false,
          matchmaking_cooldown: false,
          current_lobby_id: null,
          is_in_another_match: true,
        },
      });

      await expect(
        service.verifyLobby(makeLobby(1), makeUser(), "Competitive"),
      ).rejects.toThrow("already in a match");
    });

    it("rejects player already in a different queue", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValue({
        players_by_pk: {
          name: "InQueue",
          steam_id: "captain-steam",
          is_banned: false,
          matchmaking_cooldown: false,
          current_lobby_id: "different-lobby",
          is_in_another_match: false,
        },
      });

      await expect(
        service.verifyLobby(makeLobby(1), makeUser(), "Competitive"),
      ).rejects.toThrow("already in queue");
    });

    it("accepts player in same lobby", async () => {
      const { service, hasura } = createService();
      hasura.query.mockResolvedValue({
        players_by_pk: {
          name: "OK",
          steam_id: "captain-steam",
          is_banned: false,
          matchmaking_cooldown: false,
          current_lobby_id: "lobby-1",
          is_in_another_match: false,
        },
      });

      await expect(
        service.verifyLobby(makeLobby(1), makeUser(), "Competitive"),
      ).resolves.toBe(true);
    });
  });

  describe("getPlayerLobby", () => {
    it("returns solo player lobby when no lobby exists", async () => {
      const { service, hasura } = createService();
      mockValidateUUID.mockReturnValue(false);

      // First call: getCurrentLobbyId -> returns steamId (no current_lobby_id)
      // Second call: players_by_pk for solo player
      hasura.query
        .mockResolvedValueOnce({
          players_by_pk: { current_lobby_id: null },
        })
        .mockResolvedValueOnce({
          players_by_pk: {
            name: "SoloPlayer",
            steam_id: "solo-steam",
            is_banned: false,
            matchmaking_cooldown: false,
          },
        });

      const result = await service.getPlayerLobby("solo-steam");

      expect(result.id).toBe("solo-steam");
      expect(result.players).toHaveLength(1);
      expect(result.players[0]).toEqual({
        captain: true,
        name: "SoloPlayer",
        steam_id: "solo-steam",
        is_banned: false,
        matchmaking_cooldown: false,
      });
    });

    it("returns lobby with multiple players when lobby exists", async () => {
      const { service, hasura } = createService();
      const lobbyId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      mockValidateUUID.mockReturnValue(true);

      // First call: getCurrentLobbyId
      hasura.query
        .mockResolvedValueOnce({
          players_by_pk: { current_lobby_id: lobbyId },
        })
        // Second call: lobbies_by_pk with players
        .mockResolvedValueOnce({
          lobbies_by_pk: {
            players: [
              {
                steam_id: "captain-steam",
                captain: true,
                player: {
                  name: "Captain",
                  steam_id: "captain-steam",
                  is_banned: false,
                  matchmaking_cooldown: false,
                },
              },
              {
                steam_id: "member-steam",
                captain: false,
                player: {
                  name: "Member",
                  steam_id: "member-steam",
                  is_banned: false,
                  matchmaking_cooldown: false,
                },
              },
            ],
          },
        });

      const result = await service.getPlayerLobby("captain-steam");

      expect(result.id).toBe(lobbyId);
      expect(result.players).toHaveLength(2);
      expect(result.players[0]).toEqual({
        captain: true,
        name: "Captain",
        steam_id: "captain-steam",
        is_banned: false,
        matchmaking_cooldown: false,
      });
      expect(result.players[1]).toEqual({
        captain: false,
        name: "Member",
        steam_id: "member-steam",
        is_banned: false,
        matchmaking_cooldown: false,
      });
    });

    it("falls back to solo lobby when lobby query returns null", async () => {
      const { service, hasura } = createService();
      const lobbyId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      mockValidateUUID.mockReturnValue(true);

      hasura.query
        .mockResolvedValueOnce({
          players_by_pk: { current_lobby_id: lobbyId },
        })
        // lobbies_by_pk returns null (lobby not found)
        .mockResolvedValueOnce({
          lobbies_by_pk: null,
        })
        // Fallback solo player query
        .mockResolvedValueOnce({
          players_by_pk: {
            name: "FallbackPlayer",
            steam_id: "solo-steam",
            is_banned: false,
            matchmaking_cooldown: false,
          },
        });

      const result = await service.getPlayerLobby("solo-steam");

      expect(result.id).toBe("solo-steam");
      expect(result.players).toHaveLength(1);
      expect(result.players[0].captain).toBe(true);
      expect(result.players[0].name).toBe("FallbackPlayer");
    });
  });

  describe("setLobbyDetails", () => {
    it("stores lobby with correct ELO data in Redis", async () => {
      const { service, hasura, mockRedis } = createService();

      hasura.query.mockResolvedValueOnce({
        players: [
          { steam_id: "p1", elo: { competitive: 2500 } },
          { steam_id: "p2", elo: { competitive: 3500 } },
        ],
      });

      const lobby = {
        id: "lobby-1",
        players: [
          { steam_id: "p1", is_banned: false, matchmaking_cooldown: false },
          { steam_id: "p2", is_banned: false, matchmaking_cooldown: false },
        ],
      };

      await service.setLobbyDetails(
        ["us-east", "eu-west"],
        "Competitive",
        lobby,
      );

      expect(mockRedis.hset).toHaveBeenCalledWith(
        getMatchmakingLobbyDetailsCacheKey("lobby-1"),
        "details",
        expect.any(String),
      );

      const storedData = JSON.parse(mockRedis.hset.mock.calls[0][2]);
      expect(storedData.type).toBe("Competitive");
      expect(storedData.regions).toEqual(["us-east", "eu-west"]);
      expect(storedData.lobbyId).toBe("lobby-1");
      expect(storedData.players).toEqual([
        { steam_id: "p1", rank: 2500 },
        { steam_id: "p2", rank: 3500 },
      ]);
      expect(storedData.avgRank).toBe(3000);
      expect(storedData.regionPositions).toEqual({});
      expect(storedData.joinedAt).toBeDefined();
    });

    it("defaults ELO to 5000 when player has no ELO data", async () => {
      const { service, hasura, mockRedis } = createService();

      hasura.query.mockResolvedValueOnce({
        players: [{ steam_id: "p1", elo: null }],
      });

      const lobby = {
        id: "lobby-1",
        players: [
          { steam_id: "p1", is_banned: false, matchmaking_cooldown: false },
        ],
      };

      await service.setLobbyDetails(["us-east"], "Competitive", lobby);

      const storedData = JSON.parse(mockRedis.hset.mock.calls[0][2]);
      expect(storedData.players[0].rank).toBe(5000);
      expect(storedData.avgRank).toBe(5000);
    });

    it("uses match type to look up correct ELO field", async () => {
      const { service, hasura, mockRedis } = createService();

      hasura.query.mockResolvedValueOnce({
        players: [
          { steam_id: "p1", elo: { wingman: 4200, competitive: 3000 } },
        ],
      });

      const lobby = {
        id: "lobby-1",
        players: [
          { steam_id: "p1", is_banned: false, matchmaking_cooldown: false },
        ],
      };

      await service.setLobbyDetails(["eu-west"], "Wingman", lobby);

      const storedData = JSON.parse(mockRedis.hset.mock.calls[0][2]);
      expect(storedData.players[0].rank).toBe(4200);
      expect(storedData.type).toBe("Wingman");
    });
  });

  describe("removeLobbyDetails", () => {
    it("does nothing when lobby details do not exist", async () => {
      const { service, mockRedis } = createService();
      mockRedis.hget.mockResolvedValueOnce(null);

      await service.removeLobbyDetails("nonexistent-lobby");

      expect(mockRedis.hdel).not.toHaveBeenCalled();
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it("removes details, confirmation, and notifies all lobby players", async () => {
      const { service, mockRedis } = createService();

      const lobbyDetails = {
        type: "Competitive",
        regions: ["us-east"],
        lobbyId: "lobby-1",
        players: [
          { steam_id: "p1", rank: 3000 },
          { steam_id: "p2", rank: 4000 },
        ],
        avgRank: 3500,
        regionPositions: {},
      };

      // getLobbyDetails -> hget returns data
      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(lobbyDetails));
      // getLobbyDetails calls zrank for each region
      mockRedis.zrank.mockResolvedValueOnce(2);

      await service.removeLobbyDetails("lobby-1");

      // Should delete details
      expect(mockRedis.hdel).toHaveBeenCalledWith(
        getMatchmakingLobbyDetailsCacheKey("lobby-1"),
        "details",
      );

      // Should delete confirmationId
      expect(mockRedis.hdel).toHaveBeenCalledWith(
        getMatchmakingLobbyDetailsCacheKey("lobby-1"),
        "confirmationId",
      );

      // Should notify each player
      expect(mockRedis.publish).toHaveBeenCalledTimes(2);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: "p1",
          event: "matchmaking:details",
          data: {},
        }),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: "p2",
          event: "matchmaking:details",
          data: {},
        }),
      );
    });
  });

  describe("getLobbyDetails", () => {
    it("returns undefined when no data in Redis", async () => {
      const { service, mockRedis } = createService();
      mockRedis.hget.mockResolvedValueOnce(null);

      const result = await service.getLobbyDetails("nonexistent");

      expect(result).toBeUndefined();
    });

    it("returns parsed details with region positions", async () => {
      const { service, mockRedis } = createService();

      const storedData = {
        type: "Competitive",
        regions: ["us-east", "eu-west"],
        lobbyId: "lobby-1",
        players: [{ steam_id: "p1", rank: 3000 }],
        avgRank: 3000,
        regionPositions: {},
      };

      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(storedData));
      // zrank returns 0-based index
      mockRedis.zrank.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

      const result = await service.getLobbyDetails("lobby-1");

      expect(result.type).toBe("Competitive");
      expect(result.lobbyId).toBe("lobby-1");
      expect(result.players).toEqual([{ steam_id: "p1", rank: 3000 }]);
      // positions should be 1-based (zrank + 1)
      expect(result.regionPositions["us-east"]).toBe(3);
      expect(result.regionPositions["eu-west"]).toBe(1);
    });

    it("calls zrank with correct cache keys", async () => {
      const { service, mockRedis } = createService();

      const storedData = {
        type: "Wingman",
        regions: ["eu-central"],
        lobbyId: "lobby-x",
        players: [{ steam_id: "p1", rank: 3000 }],
        avgRank: 3000,
        regionPositions: {},
      };

      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(storedData));
      mockRedis.zrank.mockResolvedValueOnce(5);

      await service.getLobbyDetails("lobby-x");

      expect(mockRedis.zrank).toHaveBeenCalledWith(
        getMatchmakingQueueCacheKey("Wingman", "eu-central"),
        "lobby-x",
      );
    });
  });

  describe("setMatchConformationIdForLobby", () => {
    it("stores confirmation ID in Redis", async () => {
      const { service, mockRedis } = createService();

      await service.setMatchConformationIdForLobby("lobby-1", "conf-123");

      expect(mockRedis.hset).toHaveBeenCalledWith(
        getMatchmakingLobbyDetailsCacheKey("lobby-1"),
        "confirmationId",
        "conf-123",
      );
    });
  });

  describe("removeConfirmationIdFromLobby", () => {
    it("removes confirmation ID from Redis", async () => {
      const { service, mockRedis } = createService();

      await service.removeConfirmationIdFromLobby("lobby-1");

      expect(mockRedis.hdel).toHaveBeenCalledWith(
        getMatchmakingLobbyDetailsCacheKey("lobby-1"),
        "confirmationId",
      );
    });
  });

  describe("removeLobbyFromQueue", () => {
    it("returns false when lobby details do not exist", async () => {
      const { service, mockRedis, matchmaking } = createService();
      mockRedis.hget.mockResolvedValueOnce(null);

      const result = await service.removeLobbyFromQueue("nonexistent");

      expect(result).toBe(false);
      expect(mockRedis.zrem).not.toHaveBeenCalled();
      expect(matchmaking.sendRegionStats).not.toHaveBeenCalled();
    });

    it("removes lobby from both sorted sets per region and sends stats", async () => {
      const { service, mockRedis, matchmaking } = createService();

      const storedData = {
        type: "Competitive",
        regions: ["us-east", "eu-west"],
        lobbyId: "lobby-1",
        players: [{ steam_id: "p1", rank: 3000 }],
        avgRank: 3000,
        regionPositions: {},
      };

      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(storedData));
      // zrank calls from getLobbyDetails for each region
      mockRedis.zrank.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      const result = await service.removeLobbyFromQueue("lobby-1");

      expect(result).toBe(true);

      // Should remove from queue sorted set for each region
      expect(mockRedis.zrem).toHaveBeenCalledWith(
        getMatchmakingQueueCacheKey("Competitive", "us-east"),
        "lobby-1",
      );
      expect(mockRedis.zrem).toHaveBeenCalledWith(
        getMatchmakingQueueCacheKey("Competitive", "eu-west"),
        "lobby-1",
      );

      // Should remove from rank sorted set for each region
      expect(mockRedis.zrem).toHaveBeenCalledWith(
        getMatchmakingRankCacheKey("Competitive", "us-east"),
        "lobby-1",
      );
      expect(mockRedis.zrem).toHaveBeenCalledWith(
        getMatchmakingRankCacheKey("Competitive", "eu-west"),
        "lobby-1",
      );

      // Total zrem calls: 2 regions x 2 sets = 4
      expect(mockRedis.zrem).toHaveBeenCalledTimes(4);

      expect(matchmaking.sendRegionStats).toHaveBeenCalledTimes(1);
    });

    it("removes lobby from single region correctly", async () => {
      const { service, mockRedis, matchmaking } = createService();

      const storedData = {
        type: "Duel",
        regions: ["asia"],
        lobbyId: "lobby-2",
        players: [{ steam_id: "p1", rank: 2000 }],
        avgRank: 2000,
        regionPositions: {},
      };

      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(storedData));
      mockRedis.zrank.mockResolvedValueOnce(0);

      const result = await service.removeLobbyFromQueue("lobby-2");

      expect(result).toBe(true);
      expect(mockRedis.zrem).toHaveBeenCalledTimes(2);
      expect(mockRedis.zrem).toHaveBeenCalledWith(
        getMatchmakingQueueCacheKey("Duel", "asia"),
        "lobby-2",
      );
      expect(mockRedis.zrem).toHaveBeenCalledWith(
        getMatchmakingRankCacheKey("Duel", "asia"),
        "lobby-2",
      );
      expect(matchmaking.sendRegionStats).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendQueueDetailsToLobby", () => {
    it("returns early when lobby details do not exist", async () => {
      const { service, mockRedis } = createService();

      // hget for confirmationId
      mockRedis.hget.mockResolvedValueOnce(null);
      // hget for getLobbyDetails
      mockRedis.hget.mockResolvedValueOnce(null);

      await service.sendQueueDetailsToLobby("lobby-1");

      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it("publishes details without confirmation when no confirmationId", async () => {
      const { service, mockRedis } = createService();

      const lobbyDetails = {
        type: "Competitive",
        regions: ["us-east"],
        lobbyId: "lobby-1",
        players: [{ steam_id: "p1", rank: 3000 }],
        avgRank: 3000,
        regionPositions: {},
      };

      // hget for confirmationId -> null
      mockRedis.hget.mockResolvedValueOnce(null);
      // hget for getLobbyDetails (first call in sendQueueDetailsToLobby)
      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(lobbyDetails));
      mockRedis.zrank.mockResolvedValueOnce(0);
      // hget for getLobbyDetails (second call inside the publish loop)
      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(lobbyDetails));
      mockRedis.zrank.mockResolvedValueOnce(0);

      await service.sendQueueDetailsToLobby("lobby-1");

      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(publishedData.steamId).toBe("p1");
      expect(publishedData.event).toBe("matchmaking:details");
      expect(publishedData.data.details).toBeDefined();
      expect(publishedData.data.confirmation).toBeFalsy();
    });
  });

  describe("sendQueueDetailsToAllUsers", () => {
    it("queries the correct queue key for type and region", async () => {
      const { service, mockRedis } = createService();

      mockRedis.zrange.mockResolvedValueOnce([]);

      await service.sendQueueDetailsToAllUsers("Wingman", "eu-central");

      expect(mockRedis.zrange).toHaveBeenCalledWith(
        getMatchmakingQueueCacheKey("Wingman", "eu-central"),
        0,
        -1,
      );
    });

    it("sends details to all lobbies in the region queue", async () => {
      const { service, mockRedis } = createService();

      mockRedis.zrange.mockResolvedValueOnce(["lobby-a"]);

      const lobbyDetails = {
        type: "Competitive",
        regions: ["us-east"],
        lobbyId: "lobby-a",
        players: [{ steam_id: "pa", rank: 3000 }],
        avgRank: 3000,
        regionPositions: {},
      };

      // sendQueueDetailsToLobby for lobby-a:
      // hget confirmationId
      mockRedis.hget.mockResolvedValueOnce(null);
      // hget getLobbyDetails (outer)
      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(lobbyDetails));
      mockRedis.zrank.mockResolvedValueOnce(0);
      // hget getLobbyDetails (inner, for publish)
      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(lobbyDetails));
      mockRedis.zrank.mockResolvedValueOnce(0);

      await service.sendQueueDetailsToAllUsers("Competitive", "us-east");

      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(publishedData.steamId).toBe("pa");
      expect(publishedData.event).toBe("matchmaking:details");
    });
  });

  describe("sendQueueDetailsToPlayer", () => {
    it("does nothing when lobby details are not in queue", async () => {
      const { service, hasura, mockRedis } = createService();
      mockValidateUUID.mockReturnValue(false);

      // getCurrentLobbyId returns steamId itself
      hasura.query
        .mockResolvedValueOnce({
          players_by_pk: { current_lobby_id: null },
        })
        // getPlayerLobby solo player query
        .mockResolvedValueOnce({
          players_by_pk: {
            name: "Solo",
            steam_id: "solo-steam",
            is_banned: false,
            matchmaking_cooldown: false,
          },
        });

      // sendQueueDetailsToLobby -> hget confirmationId
      mockRedis.hget.mockResolvedValueOnce(null);
      // sendQueueDetailsToLobby -> getLobbyDetails returns null
      mockRedis.hget.mockResolvedValueOnce(null);

      await service.sendQueueDetailsToPlayer("solo-steam");

      // Should not publish since getLobbyDetails returns null
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });
  });
});
