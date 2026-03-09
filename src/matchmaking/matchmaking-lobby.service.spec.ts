jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { PlayerLobby } from "./types/PlayerLobby";
import { JoinQueueError } from "./utilities/joinQueueError";
import { User } from "../auth/types/User";

function createService(hasuraOverrides: Record<string, jest.Mock> = {}) {
  const mockRedis = {
    hset: jest.fn(),
    hget: jest.fn(),
    hdel: jest.fn(),
    zrank: jest.fn(),
    zrange: jest.fn(),
    zrem: jest.fn(),
    publish: jest.fn(),
  };

  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
    ...hasuraOverrides,
  };

  const redisManager = { getConnection: jest.fn().mockReturnValue(mockRedis) };
  const matchmaking = { sendRegionStats: jest.fn() };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as unknown as Logger;

  const service = new MatchmakingLobbyService(
    logger,
    hasura as any,
    redisManager as any,
    matchmaking as any,
  );

  return { service, hasura, mockRedis };
}

function makeUser(steamId = "captain-steam"): User {
  return { steam_id: steamId } as User;
}

function makeLobby(playerCount: number, captainId = "captain-steam"): PlayerLobby {
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
});
