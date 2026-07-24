import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { e_match_types_enum } from "generated";

import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { HasuraService } from "../hasura/hasura.service";
import { MatchmakeService } from "./matchmake.service";
import { PlayerLobby } from "./types/PlayerLobby";
import { JoinQueueError } from "./utilities/joinQueueError";
import { User } from "../auth/types/User";

describe("MatchmakingLobbyService.verifyLobby", () => {
  let service: MatchmakingLobbyService;
  let mockHasura: jest.Mocked<HasuraService>;

  const captainSteamId = "steam-id-1";

  const buildLobby = (playerCount: number): PlayerLobby => ({
    id: "lobby-1",
    players: Array.from({ length: playerCount }, (_, index) => ({
      captain: index === 0,
      name: `player-${index + 1}`,
      steam_id: index === 0 ? captainSteamId : `steam-id-${index + 1}`,
      is_banned: false,
      matchmaking_cooldown: false,
    })),
  });

  const captain = { steam_id: captainSteamId } as User;

  beforeEach(() => {
    // verifyPlayer runs per lobby member once the size check passes — every
    // player comes back clean so only the party-size rule can fail.
    mockHasura = {
      query: jest.fn().mockImplementation(({ players_by_pk }) => ({
        players_by_pk: {
          name: "player",
          steam_id: players_by_pk.__args.steam_id,
          is_banned: false,
          matchmaking_cooldown: false,
          current_lobby_id: "lobby-1",
          is_in_another_match: false,
        },
      })),
    } as any;

    const mockRedisManager = {
      getConnection: jest.fn().mockReturnValue({} as Redis),
    } as any;

    service = new MatchmakingLobbyService(
      new Logger("Test"),
      mockHasura,
      mockRedisManager,
      {} as MatchmakeService,
    );
  });

  it("rejects a player who is not the lobby captain", async () => {
    await expect(
      service.verifyLobby(
        buildLobby(2),
        { steam_id: "steam-id-2" } as User,
        "Competitive",
      ),
    ).rejects.toThrow("you are not the captain of this lobby");
  });

  describe("Competitive (10 players)", () => {
    const type: e_match_types_enum = "Competitive";

    it.each([1, 2, 3, 4, 5, 10])("accepts a party of %i", async (size) => {
      await expect(
        service.verifyLobby(buildLobby(size), captain, type),
      ).resolves.toBe(true);
    });

    it.each([6, 7, 8, 9, 11, 12])("rejects a party of %i", async (size) => {
      await expect(
        service.verifyLobby(buildLobby(size), captain, type),
      ).rejects.toBeInstanceOf(JoinQueueError);
    });

    it("explains the requirement when the party is between the two valid sizes", async () => {
      await expect(
        service.verifyLobby(buildLobby(7), captain, type),
      ).rejects.toThrow(
        "To join a Competitive match, your lobby must have 5 or fewer players, or exactly 10 players. You have 7.",
      );
    });

    it("rejects a party larger than the match itself", async () => {
      await expect(
        service.verifyLobby(buildLobby(11), captain, type),
      ).rejects.toThrow("You have 11.");
    });
  });

  describe("Wingman (4 players)", () => {
    const type: e_match_types_enum = "Wingman";

    it.each([1, 2, 4])("accepts a party of %i", async (size) => {
      await expect(
        service.verifyLobby(buildLobby(size), captain, type),
      ).resolves.toBe(true);
    });

    it.each([3, 5, 6, 10])("rejects a party of %i", async (size) => {
      await expect(
        service.verifyLobby(buildLobby(size), captain, type),
      ).rejects.toBeInstanceOf(JoinQueueError);
    });
  });

  describe("Duel (2 players)", () => {
    const type: e_match_types_enum = "Duel";

    it.each([1, 2])("accepts a party of %i", async (size) => {
      await expect(
        service.verifyLobby(buildLobby(size), captain, type),
      ).resolves.toBe(true);
    });

    it.each([3, 4, 5, 10])("rejects a party of %i", async (size) => {
      await expect(
        service.verifyLobby(buildLobby(size), captain, type),
      ).rejects.toBeInstanceOf(JoinQueueError);
    });
  });

  it("does not run per-player verification when the party size is invalid", async () => {
    await expect(
      service.verifyLobby(buildLobby(7), captain, "Competitive"),
    ).rejects.toThrow(JoinQueueError);

    expect(mockHasura.query).not.toHaveBeenCalled();
  });

  it("still rejects a valid-sized party when a member is banned", async () => {
    mockHasura.query.mockResolvedValueOnce({
      players_by_pk: {
        name: "banned-player",
        steam_id: captainSteamId,
        is_banned: true,
        matchmaking_cooldown: false,
        current_lobby_id: "lobby-1",
        is_in_another_match: false,
      },
    } as any);

    await expect(
      service.verifyLobby(buildLobby(5), captain, "Competitive"),
    ).rejects.toThrow("banned-player is banned");
  });
});
