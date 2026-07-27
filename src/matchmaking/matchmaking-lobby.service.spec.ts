import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { e_match_types_enum } from "generated";

import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { HasuraService } from "../hasura/hasura.service";
import { MatchmakeService } from "./matchmake.service";
import { PlayerLobby } from "./types/PlayerLobby";
import { JoinQueueError } from "./utilities/joinQueueError";
import { User } from "../auth/types/User";
import { ExpectedPlayers } from "../discord-bot/enums/ExpectedPlayers";

/**
 * The party-size rule: a lobby may queue when it fits in one lineup (<= half
 * the match) or fills the whole match exactly. Everything else is unplaceable.
 */
describe("MatchmakingLobbyService.verifyLobby", () => {
  let service: MatchmakingLobbyService;
  let mockHasura: jest.Mocked<HasuraService>;

  const captainSteamId = "steam-id-1";
  const captain = { steam_id: captainSteamId } as User;

  // Premier and Faceit are demo-import only — they are never matchmade.
  const matchmakingTypes: e_match_types_enum[] = [
    "Duel",
    "Wingman",
    "Competitive",
  ];

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

  const canQueue = async (type: e_match_types_enum, partySize: number) => {
    try {
      return await service.verifyLobby(buildLobby(partySize), captain, type);
    } catch (error) {
      if (error instanceof JoinQueueError) {
        return false;
      }
      throw error;
    }
  };

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

  describe("Duel (2 players, 1v1)", () => {
    const type: e_match_types_enum = "Duel";

    it("accepts a solo player — fills one lineup", async () => {
      await expect(canQueue(type, 1)).resolves.toBe(true);
    });

    it("accepts a full party of 2 — both lineups, split in-house", async () => {
      await expect(canQueue(type, 2)).resolves.toBe(true);
    });

    it.each([3, 4, 5, 10, 11])("rejects a party of %i", async (size) => {
      await expect(canQueue(type, size)).resolves.toBe(false);
    });

    it("explains the requirement", async () => {
      await expect(
        service.verifyLobby(buildLobby(3), captain, type),
      ).rejects.toThrow(
        "To join a Duel match, your lobby must have 1 or fewer players, or exactly 2 players. You have 3.",
      );
    });
  });

  describe("Wingman (4 players, 2v2)", () => {
    const type: e_match_types_enum = "Wingman";

    it.each([1, 2])("accepts a party of %i — fits one lineup", async (size) => {
      await expect(canQueue(type, size)).resolves.toBe(true);
    });

    it("accepts a full party of 4", async () => {
      await expect(canQueue(type, 4)).resolves.toBe(true);
    });

    it("rejects a party of 3 — too big for one lineup, too small for two", async () => {
      await expect(canQueue(type, 3)).resolves.toBe(false);
    });

    it.each([5, 6, 10, 11])("rejects a party of %i", async (size) => {
      await expect(canQueue(type, size)).resolves.toBe(false);
    });

    it("explains the requirement", async () => {
      await expect(
        service.verifyLobby(buildLobby(3), captain, type),
      ).rejects.toThrow(
        "To join a Wingman match, your lobby must have 2 or fewer players, or exactly 4 players. You have 3.",
      );
    });
  });

  describe("Competitive (10 players, 5v5)", () => {
    const type: e_match_types_enum = "Competitive";

    it.each([1, 2, 3, 4, 5])(
      "accepts a party of %i — fits one lineup",
      async (size) => {
        await expect(canQueue(type, size)).resolves.toBe(true);
      },
    );

    it("accepts a full party of 10", async () => {
      await expect(canQueue(type, 10)).resolves.toBe(true);
    });

    it.each([6, 7, 8, 9])(
      "rejects a party of %i — between one lineup and a full match",
      async (size) => {
        await expect(canQueue(type, size)).resolves.toBe(false);
      },
    );

    it.each([11, 12, 15, 20])(
      "rejects a party of %i — larger than the match itself",
      async (size) => {
        await expect(canQueue(type, size)).resolves.toBe(false);
      },
    );

    it("explains the requirement", async () => {
      await expect(
        service.verifyLobby(buildLobby(7), captain, type),
      ).rejects.toThrow(
        "To join a Competitive match, your lobby must have 5 or fewer players, or exactly 10 players. You have 7.",
      );
    });

    it("reports the party size when it is over the full match size", async () => {
      await expect(
        service.verifyLobby(buildLobby(11), captain, type),
      ).rejects.toThrow("You have 11.");
    });
  });

  describe("the party sizes from the queue matrix", () => {
    const queueableTypes = async (size: number) => {
      const queueable: e_match_types_enum[] = [];
      for (const type of matchmakingTypes) {
        if (await canQueue(type, size)) {
          queueable.push(type);
        }
      }
      return queueable;
    };

    it("1 — every mode", async () => {
      await expect(queueableTypes(1)).resolves.toEqual([
        "Duel",
        "Wingman",
        "Competitive",
      ]);
    });

    it("2 — every mode (full Duel, half a Wingman)", async () => {
      await expect(queueableTypes(2)).resolves.toEqual([
        "Duel",
        "Wingman",
        "Competitive",
      ]);
    });

    it("3 — Competitive only", async () => {
      await expect(queueableTypes(3)).resolves.toEqual(["Competitive"]);
    });

    it("4 — Wingman and Competitive", async () => {
      await expect(queueableTypes(4)).resolves.toEqual([
        "Wingman",
        "Competitive",
      ]);
    });

    it("5 — Competitive only", async () => {
      await expect(queueableTypes(5)).resolves.toEqual(["Competitive"]);
    });

    it.each([6, 7, 8, 9])("%i — nothing is queueable", async (size) => {
      await expect(queueableTypes(size)).resolves.toEqual([]);
    });

    it("10 — Competitive only", async () => {
      await expect(queueableTypes(10)).resolves.toEqual(["Competitive"]);
    });

    it.each([11, 12, 20])(
      "%i — nothing is queueable, over every match size",
      async (size) => {
        await expect(queueableTypes(size)).resolves.toEqual([]);
      },
    );
  });

  it("stays in sync with ExpectedPlayers for every matchmaking type", async () => {
    for (const type of matchmakingTypes) {
      const expected = ExpectedPlayers[type];
      const half = expected / 2;

      await expect(canQueue(type, half)).resolves.toBe(true);
      await expect(canQueue(type, half + 1)).resolves.toBe(
        half + 1 === expected,
      );
      await expect(canQueue(type, expected)).resolves.toBe(true);
      await expect(canQueue(type, expected + 1)).resolves.toBe(false);
    }
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

/**
 * The elo snapshot taken when a lobby joins the queue. get_player_elo returns a
 * jsonb blob whose per-type value is SQL NULL for a player with no rated games,
 * and which has no key at all for Premier/Faceit. Number(null) is 0 and
 * Number(undefined) is NaN, so an unguarded read either seeds a brand new
 * player at rank 0 or poisons every average in the queue with NaN.
 */
describe("MatchmakingLobbyService.setLobbyDetails", () => {
  let service: MatchmakingLobbyService;
  let mockHasura: jest.Mocked<HasuraService>;
  let stored: Record<string, string>;

  const buildLobby = (steamIds: string[]) => ({
    id: "lobby-1",
    players: steamIds.map((steam_id) => ({
      steam_id,
      is_banned: false,
      matchmaking_cooldown: false,
    })),
  });

  const queuedRanks = () =>
    JSON.parse(stored.details).players.map(
      (player: { rank: number }) => player.rank,
    );

  const setup = (elo: Record<string, unknown>[]) => {
    stored = {};
    mockHasura = {
      query: jest.fn().mockResolvedValue({
        players: elo.map((value, index) => ({
          steam_id: `steam-${index + 1}`,
          elo: value,
        })),
      }),
    } as any;

    const mockRedisManager = {
      getConnection: jest.fn().mockReturnValue({
        hset: jest.fn(async (_key: string, field: string, value: string) => {
          stored[field] = value;
          return 1;
        }),
      } as unknown as Redis),
    } as any;

    service = new MatchmakingLobbyService(
      new Logger("Test"),
      mockHasura,
      mockRedisManager,
      {} as MatchmakeService,
    );
  };

  it("uses the rated elo when the player has one", async () => {
    setup([{ competitive: 4200 }]);

    await service.setLobbyDetails(["us-east"], "Competitive", buildLobby(["steam-1"]));

    expect(queuedRanks()).toEqual([4200]);
  });

  it("defaults an unrated player to 5000 rather than 0", async () => {
    // get_player_elo_by_type returns NULL for a player with no player_elo rows
    setup([{ competitive: null }]);

    await service.setLobbyDetails(["us-east"], "Competitive", buildLobby(["steam-1"]));

    expect(queuedRanks()).toEqual([5000]);
  });

  it("defaults to 5000 when the type is missing from the blob", async () => {
    setup([{ competitive: 4200 }]);

    await service.setLobbyDetails(["us-east"], "Premier", buildLobby(["steam-1"]));

    expect(queuedRanks()).toEqual([5000]);
  });

  it("defaults to 5000 when the player has no elo row at all", async () => {
    setup([]);

    await service.setLobbyDetails(["us-east"], "Competitive", buildLobby(["steam-1"]));

    expect(queuedRanks()).toEqual([5000]);
  });

  it("keeps avgRank finite when some of the party is unrated", async () => {
    setup([{ competitive: 3000 }, { competitive: null }, { competitive: null }]);

    await service.setLobbyDetails(
      ["us-east"],
      "Competitive",
      buildLobby(["steam-1", "steam-2", "steam-3"]),
    );

    const details = JSON.parse(stored.details);
    expect(details.players.map((p: { rank: number }) => p.rank)).toEqual([
      3000, 5000, 5000,
    ]);
    expect(Number.isFinite(details.avgRank)).toBe(true);
    expect(details.avgRank).toBeCloseTo(13000 / 3, 9);
  });
});
