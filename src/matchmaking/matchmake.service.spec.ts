import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { e_match_types_enum } from "generated";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { MatchmakingTeam } from "./types/MatchmakingTeam";
import Redis from "ioredis";

// Mock the problematic modules before importing the service
jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn().mockImplementation(() => ({
    createMatchBasedOnType: jest.fn(),
    updateMatchStatus: jest.fn(),
  })),
}));

import { MatchmakeService } from "./matchmake.service";
import { HasuraService } from "../hasura/hasura.service";
import { MatchAssistantService } from "../matches/match-assistant/match-assistant.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { MatchmakingQueues } from "./enums/MatchmakingQueues";

type ConfirmationTeams = { team1: MatchmakingTeam; team2: MatchmakingTeam };

describe("MatchmakeService", () => {
  let service: MatchmakeService;
  let mockRedis: jest.Mocked<Redis>;
  let mockHasura: jest.Mocked<HasuraService>;
  let mockMatchAssistant: jest.Mocked<MatchAssistantService>;
  let mockMatchmakingLobbyService: jest.Mocked<MatchmakingLobbyService>;
  let mockRedisManager: jest.Mocked<RedisManagerService>;
  let mockQueue: jest.Mocked<Queue>;
  let logger: Logger;

  beforeEach(async () => {
    // Create mock Redis instance
    mockRedis = {
      set: jest.fn().mockResolvedValue("OK"),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      zadd: jest.fn().mockResolvedValue(1),
      zcard: jest.fn().mockResolvedValue(0),
      zrange: jest.fn().mockResolvedValue([]),
      hset: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn().mockResolvedValue({}),
      hget: jest.fn().mockResolvedValue(null),
      hdel: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    } as any;

    // Create mock services
    mockHasura = {
      query: jest.fn(),
      mutation: jest.fn(),
    } as any;

    mockMatchAssistant = {
      createMatchBasedOnType: jest.fn(),
      updateMatchStatus: jest.fn(),
    } as any;

    mockMatchmakingLobbyService = {
      getLobbyDetails: jest.fn(),
      removeLobbyFromQueue: jest.fn(),
      removeLobbyDetails: jest.fn(),
      setMatchConformationIdForLobby: jest.fn(),
      sendQueueDetailsToLobby: jest.fn(),
      removeConfirmationIdFromLobby: jest.fn(),
    } as any;

    mockRedisManager = {
      getConnection: jest.fn().mockReturnValue(mockRedis),
    } as any;

    mockQueue = {
      add: jest.fn(),
      remove: jest.fn(),
    } as any;

    logger = new Logger("Test");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: Logger,
          useValue: logger,
        },
        MatchmakeService,
        {
          provide: HasuraService,
          useValue: mockHasura,
        },
        {
          provide: MatchAssistantService,
          useValue: mockMatchAssistant,
        },
        {
          provide: MatchmakingLobbyService,
          useValue: mockMatchmakingLobbyService,
        },
        {
          provide: RedisManagerService,
          useValue: mockRedisManager,
        },
        {
          provide: `BullQueue_${MatchmakingQueues.Matchmaking}`,
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<MatchmakeService>(MatchmakeService);
  });

  describe("createMatches", () => {
    it("should create exactly 1 match when there are 15 players in the queue for Competitive", async () => {
      const region = "us-east";
      const type: e_match_types_enum = "Competitive";
      const requiredPlayers = 10; // Competitive requires 10 players

      // Create 15 players across multiple lobbies
      // We'll create 3 lobbies: one with 5 players, one with 5 players, and one with 5 players
      // This should create 1 match with 10 players (5+5), leaving 5 players unmatched
      const lobbies: MatchmakingLobby[] = [
        {
          lobbyId: "lobby-1",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-id-${i + 1}`,
            rank: 1000,
          })),
          avgRank: 1000,
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-2",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-id-${i + 6}`,
            rank: 1050,
          })),
          avgRank: 1050,
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-3",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-id-${i + 11}`,
            rank: 1100,
          })),
          avgRank: 1100,
          joinedAt: new Date(),
          regionPositions: {},
        },
      ];

      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) => {
          return lobbies.find((l) => l.lobbyId === lobbyId) || null;
        },
      );

      // Mock createMatchConfirmation by spying on the method
      const createMatchConfirmationSpy = jest.spyOn(
        service as any,
        "createMatchConfirmation",
      );

      // Call the private method using bracket notation
      const result = await (service as any).createMatches(
        region,
        type,
        lobbies,
      );

      // Verify that createMatchConfirmation was called exactly once
      expect(createMatchConfirmationSpy).toHaveBeenCalledTimes(1);

      // Verify the match confirmation was called with correct parameters
      const callArgs = createMatchConfirmationSpy.mock.calls[0];
      expect(callArgs[0]).toBe(region);
      expect(callArgs[1]).toBe(type);

      const { team1, team2 } = callArgs[2] as ConfirmationTeams;

      // Verify each team has exactly 5 players (half of 10)
      expect(team1.players.length).toBe(5);
      expect(team2.players.length).toBe(5);

      // Verify total players in the match is 10
      expect(team1.players.length + team2.players.length).toBe(requiredPlayers);

      // 15 queued, 10 matched, so 5 are left over and reported accurately so
      // the caller knows to expand the search
      expect(result).toBe(5);

      // the two closest lobbies play; the 1100 lobby stays queued
      const matched = [...team1.lobbies, ...team2.lobbies];
      expect(matched.sort()).toEqual(["lobby-1", "lobby-2"]);
      expect(Math.abs(team1.avgRank - team2.avgRank)).toBe(50);

      // Verify claimLobby was called (via redis.eval) for each lobby
      expect(mockRedis.eval).toHaveBeenCalled();

      createMatchConfirmationSpy.mockRestore();
    });

    it("should not create a match when there are fewer players than required", async () => {
      const region = "us-east";
      const type: e_match_types_enum = "Competitive";

      // Create only 8 players (less than required 10)
      const lobbies: MatchmakingLobby[] = [
        {
          lobbyId: "lobby-1",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-id-${i + 1}`,
            rank: 1000,
          })),
          avgRank: 1000,
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-2",
          type,
          regions: [region],
          players: Array.from({ length: 3 }, (_, i) => ({
            steam_id: `steam-id-${i + 6}`,
            rank: 1050,
          })),
          avgRank: 1050,
          joinedAt: new Date(),
          regionPositions: {},
        },
      ];

      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) => {
          return lobbies.find((l) => l.lobbyId === lobbyId) || null;
        },
      );

      const createMatchConfirmationSpy = jest.spyOn(
        service as any,
        "createMatchConfirmation",
      );

      const result = await (service as any).createMatches(
        region,
        type,
        lobbies,
      );

      // Should not create a match
      expect(createMatchConfirmationSpy).not.toHaveBeenCalled();

      // Should return the number of players that couldn't be matched
      expect(result).toBe(8);

      createMatchConfirmationSpy.mockRestore();
    });

    it("should create exactly 1 match when there are exactly 10 players", async () => {
      const region = "us-east";
      const type: e_match_types_enum = "Competitive";

      // Create exactly 10 players across 2 lobbies
      const lobbies: MatchmakingLobby[] = [
        {
          lobbyId: "lobby-1",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-id-${i + 1}`,
            rank: 1000,
          })),
          avgRank: 1000,
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-2",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-id-${i + 6}`,
            rank: 1050,
          })),
          avgRank: 1050,
          joinedAt: new Date(),
          regionPositions: {},
        },
      ];

      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) => {
          return lobbies.find((l) => l.lobbyId === lobbyId) || null;
        },
      );

      const createMatchConfirmationSpy = jest.spyOn(
        service as any,
        "createMatchConfirmation",
      );

      const result = await (service as any).createMatches(
        region,
        type,
        lobbies,
      );

      // Should create exactly 1 match
      expect(createMatchConfirmationSpy).toHaveBeenCalledTimes(1);

      // All players should be matched
      expect(result).toBe(0);

      createMatchConfirmationSpy.mockRestore();
    });

    it("should create 2 matches when there are 20 players in two distinct ELO groups", async () => {
      const region = "us-east";
      const type: e_match_types_enum = "Competitive";

      // Group 1: High rank players (avg rank ~6002.4)
      // Ranks: 6000, 6001, 6002, 6004, 6005 (duplicated to get 10 lobbies)
      // Each lobby has exactly 1 player for easy tracking
      const highRankRanks = [
        6000, 6001, 6002, 6004, 6005, 6000, 6001, 6002, 6004, 6005,
      ];
      const highRankGroup: MatchmakingLobby[] = highRankRanks.map(
        (rank, index) => ({
          lobbyId: `lobby-high-${index + 1}`,
          type,
          regions: [region],
          players: [{ steam_id: `steam-high-${index + 1}`, rank }],
          avgRank: rank,
          joinedAt: new Date(),
          regionPositions: {},
        }),
      );

      // Group 2: Lower rank players (avg rank ~5300)
      // Ranks: 5100, 5200, 5300, 5400, 5500 (duplicated to get 10 lobbies)
      // Each lobby has exactly 1 player for easy tracking
      const lowRankRanks = [
        5100, 5200, 5300, 5400, 5500, 5100, 5200, 5300, 5400, 5500,
      ];
      const lowRankGroup: MatchmakingLobby[] = lowRankRanks.map(
        (rank, index) => ({
          lobbyId: `lobby-low-${index + 1}`,
          type,
          regions: [region],
          players: [{ steam_id: `steam-low-${index + 1}`, rank }],
          avgRank: rank,
          joinedAt: new Date(),
          regionPositions: {},
        }),
      );

      // Calculate average ranks for verification
      // High rank group: (6000+6001+6002+6004+6005)/5 = 6002.4
      const highRankAvg = (6000 + 6001 + 6002 + 6004 + 6005) / 5;
      // Low rank group: (5100+5200+5300+5400+5500)/5 = 5300
      const lowRankAvg = (5100 + 5200 + 5300 + 5400 + 5500) / 5;

      const allLobbies = [...highRankGroup, ...lowRankGroup];
      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) => {
          return allLobbies.find((l) => l.lobbyId === lobbyId) || null;
        },
      );

      // Mock createMatchConfirmation by spying on the method
      const createMatchConfirmationSpy = jest
        .spyOn(service as any, "createMatchConfirmation")
        .mockImplementation(async () => {
          // Mock implementation to prevent errors
          return Promise.resolve();
        });

      // Call createMatches for the high rank group (should create 1 match)
      await (service as any).createMatches(region, type, highRankGroup);

      // Call createMatches for the low rank group (should create 1 match)
      await (service as any).createMatches(region, type, lowRankGroup);

      // Verify that createMatchConfirmation was called exactly 2 times (2 matches)
      expect(createMatchConfirmationSpy).toHaveBeenCalledTimes(2);

      // Verify the first match confirmation (high rank group)
      const firstCallArgs = createMatchConfirmationSpy.mock.calls[0];
      expect(firstCallArgs[0]).toBe(region);
      expect(firstCallArgs[1]).toBe(type);

      const { team1: team1Match1, team2: team2Match1 } = firstCallArgs[2] as ConfirmationTeams;
      expect(team1Match1.players.length).toBe(5);
      expect(team2Match1.players.length).toBe(5);
      expect(team1Match1.players.length + team2Match1.players.length).toBe(10);

      // Verify the second match confirmation (low rank group)
      const secondCallArgs = createMatchConfirmationSpy.mock.calls[1];
      expect(secondCallArgs[0]).toBe(region);
      expect(secondCallArgs[1]).toBe(type);

      const { team1: team1Match2, team2: team2Match2 } = secondCallArgs[2] as ConfirmationTeams;
      expect(team1Match2.players.length).toBe(5);
      expect(team2Match2.players.length).toBe(5);
      expect(team1Match2.players.length + team2Match2.players.length).toBe(10);

      // Log average ranks for verification
      console.log(`High rank group average: ${highRankAvg}`);
      console.log(`Low rank group average: ${lowRankAvg}`);
      console.log(
        `Match 1 (High Rank) - Team 1 avg rank: ${team1Match1.avgRank}, Team 2 avg rank: ${team2Match1.avgRank}`,
      );
      console.log(
        `Match 2 (Low Rank) - Team 1 avg rank: ${team1Match2.avgRank}, Team 2 avg rank: ${team2Match2.avgRank}`,
      );

      // Verify that the matches have reasonable ELO balance within each match
      // The ELO difference within a match should be smaller than between matches
      const match1EloDiff = Math.abs(team1Match1.avgRank - team2Match1.avgRank);
      const match2EloDiff = Math.abs(team1Match2.avgRank - team2Match2.avgRank);
      const betweenMatchesEloDiff = Math.abs(
        (team1Match1.avgRank + team2Match1.avgRank) / 2 -
          (team1Match2.avgRank + team2Match2.avgRank) / 2,
      );

      // ELO difference within matches should be reasonable
      expect(match1EloDiff).toBeLessThan(100); // High rank match should be balanced
      expect(match2EloDiff).toBeLessThan(100); // Low rank match should be balanced

      // ELO difference between matches should be significant (showing they're separate groups)
      expect(betweenMatchesEloDiff).toBeGreaterThan(500);

      createMatchConfirmationSpy.mockRestore();
    });

    it("should create 1 match with high variability in lobby sizes and ensure similar ranks", async () => {
      const region = "us-east";
      const type: e_match_types_enum = "Competitive";

      // Create lobbies with high variability in player count
      // Total: 1 + 2 + 1 + 3 + 1 + 2 = 10 players
      const lobbies: MatchmakingLobby[] = [
        {
          lobbyId: "lobby-1",
          type,
          regions: [region],
          players: [{ steam_id: "steam-1", rank: 5500 }],
          avgRank: 5500, // 1 player
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-2",
          type,
          regions: [region],
          players: [
            { steam_id: "steam-2", rank: 4500 },
            { steam_id: "steam-3", rank: 4500 },
          ],
          avgRank: 4500, // 2 players
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-3",
          type,
          regions: [region],
          players: [{ steam_id: "steam-4", rank: 3500 }],
          avgRank: 3500, // 1 player
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-4",
          type,
          regions: [region],
          players: [
            { steam_id: "steam-5", rank: 2500 },
            { steam_id: "steam-6", rank: 2500 },
            { steam_id: "steam-7", rank: 2500 },
          ],
          avgRank: 2500, // 3 players
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-5",
          type,
          regions: [region],
          players: [{ steam_id: "steam-8", rank: 2500 }],
          avgRank: 2500, // 1 player
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-6",
          type,
          regions: [region],
          players: [
            { steam_id: "steam-9", rank: 2000 },
            { steam_id: "steam-10", rank: 2000 },
          ],
          avgRank: 2000, // 2 players
          joinedAt: new Date(),
          regionPositions: {},
        },
      ];

      // Verify total players
      const totalPlayers = lobbies.reduce(
        (sum, lobby) => sum + lobby.players.length,
        0,
      );
      expect(totalPlayers).toBe(10);

      // Save original lobby players before createMatches modifies the array
      // Extract steam_id from player objects for comparison
      const allLobbyPlayers = lobbies.flatMap((lobby) =>
        lobby.players.map((p) => (typeof p === "string" ? p : p.steam_id)),
      );

      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) => {
          return lobbies.find((l) => l.lobbyId === lobbyId) || null;
        },
      );

      // Mock createMatchConfirmation by spying on the method
      const createMatchConfirmationSpy = jest
        .spyOn(service as any, "createMatchConfirmation")
        .mockImplementation(async () => {
          // Mock implementation to prevent errors
          return Promise.resolve();
        });

      // Call the private method
      const result = await (service as any).createMatches(
        region,
        type,
        lobbies,
      );

      // Verify that createMatchConfirmation was called exactly once
      expect(createMatchConfirmationSpy).toHaveBeenCalledTimes(1);

      // Verify the match confirmation
      const callArgs = createMatchConfirmationSpy.mock.calls[0];
      expect(callArgs[0]).toBe(region);
      expect(callArgs[1]).toBe(type);

      const { team1, team2 } = callArgs[2] as ConfirmationTeams;

      // Verify each team has exactly 5 players
      expect(team1.players.length).toBe(5);
      expect(team2.players.length).toBe(5);
      expect(team1.players.length + team2.players.length).toBe(10);

      // every party is wholly on one team, and every lobby is used
      for (const lobby of lobbies) {
        const onTeam1 = team1.lobbies.includes(lobby.lobbyId);
        const onTeam2 = team2.lobbies.includes(lobby.lobbyId);
        expect(onTeam1 !== onTeam2).toBe(true);
      }

      // every player is used exactly once
      const allMatchedPlayers = [
        ...team1.players.map((p) => p.steam_id),
        ...team2.players.map((p) => p.steam_id),
      ];
      expect(allMatchedPlayers.sort()).toEqual(allLobbyPlayers.sort());

      // the party sizes here (1/2/1/3/1/2) only allow side totals of 11500,
      // 13500, 15500, 16500, 18500 or 20500 out of 32000, so a perfect
      // 16000/16000 split does not exist and 200 is the optimum
      expect(Math.abs(team1.avgRank - team2.avgRank)).toBe(200);

      // Result should be 0 since all players were matched
      expect(result).toBe(0);

      createMatchConfirmationSpy.mockRestore();
    });
  });

  describe("claimLobby", () => {
    it("should return false when lobby is already claimed by another region", async () => {
      const lobby: MatchmakingLobby = {
        lobbyId: "lobby-multi-region",
        type: "Competitive",
        regions: ["us-east", "eu-west"],
        players: [
          { steam_id: "steam-1", rank: 1000 },
          { steam_id: "steam-2", rank: 1000 },
          { steam_id: "steam-3", rank: 1000 },
          { steam_id: "steam-4", rank: 1000 },
          { steam_id: "steam-5", rank: 1000 },
        ],
        avgRank: 1000,
        joinedAt: new Date(),
        regionPositions: {},
      };

      mockMatchmakingLobbyService.getLobbyDetails.mockResolvedValue(lobby);

      // First call succeeds (returns 1)
      mockRedis.eval.mockResolvedValueOnce(1);
      const firstClaim = await (service as any).claimLobby(
        "lobby-multi-region",
      );
      expect(firstClaim).toBe(true);

      // Second call fails (returns 0 — lock already held)
      mockRedis.eval.mockResolvedValueOnce(0);
      const secondClaim = await (service as any).claimLobby(
        "lobby-multi-region",
      );
      expect(secondClaim).toBe(false);
    });

    it("should pass all regional queue and rank keys to the Lua script", async () => {
      const lobby: MatchmakingLobby = {
        lobbyId: "lobby-keys-test",
        type: "Competitive",
        regions: ["us-east", "eu-west"],
        players: [{ steam_id: "steam-1", rank: 1000 }],
        avgRank: 1000,
        joinedAt: new Date(),
        regionPositions: {},
      };

      mockMatchmakingLobbyService.getLobbyDetails.mockResolvedValue(lobby);
      mockRedis.eval.mockResolvedValue(1);

      await (service as any).claimLobby("lobby-keys-test");

      // Verify eval was called with correct keys
      const evalCall = mockRedis.eval.mock.calls[0];
      const numKeys = evalCall[1] as number;
      const keys = evalCall.slice(2, 2 + numKeys);

      // Should have: 1 lock key + 2 regions * 2 keys (queue + rank) = 5 keys
      expect(numKeys).toBe(5);
      expect(keys[0]).toBe("matchmaking:lock:lobby-keys-test");
      expect(keys).toContainEqual(expect.stringContaining("us-east"));
      expect(keys).toContainEqual(expect.stringContaining("eu-west"));
    });

    it("should return false when lobby details not found", async () => {
      mockMatchmakingLobbyService.getLobbyDetails.mockResolvedValue(null);

      const result = await (service as any).claimLobby("nonexistent-lobby");
      expect(result).toBe(false);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe("createMatches with multi-region lobbies", () => {
    it("should skip lobbies that fail to claim (already claimed by another region)", async () => {
      const region = "us-east";
      const type: e_match_types_enum = "Competitive";

      const lobbies: MatchmakingLobby[] = [
        {
          lobbyId: "lobby-1",
          type,
          regions: [region, "eu-west"],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-${i + 1}`,
            rank: 1000,
          })),
          avgRank: 1000,
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-2",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-${i + 6}`,
            rank: 1050,
          })),
          avgRank: 1050,
          joinedAt: new Date(),
          regionPositions: {},
        },
        {
          lobbyId: "lobby-3",
          type,
          regions: [region],
          players: Array.from({ length: 5 }, (_, i) => ({
            steam_id: `steam-${i + 11}`,
            rank: 1100,
          })),
          avgRank: 1100,
          joinedAt: new Date(),
          regionPositions: {},
        },
      ];

      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) => {
          return lobbies.find((l) => l.lobbyId === lobbyId) || null;
        },
      );

      // lobby-1 fails to claim (another region got it), lobby-2 and lobby-3 succeed.
      // keyed off the lock key rather than call order, since lobbies are now
      // claimed in preference order rather than input order
      mockRedis.eval.mockImplementation((...args: any[]) =>
        Promise.resolve(args[2] === "matchmaking:lock:lobby-1" ? 0 : 1),
      );

      const createMatchConfirmationSpy = jest
        .spyOn(service as any, "createMatchConfirmation")
        .mockResolvedValue(undefined);

      await (service as any).createMatches(region, type, lobbies);

      // Should still create a match from lobby-2 + lobby-3
      expect(createMatchConfirmationSpy).toHaveBeenCalledTimes(1);
      const callArgs = createMatchConfirmationSpy.mock.calls[0];
      const { team1, team2 } = callArgs[2] as ConfirmationTeams;
      expect(team1.players.length + team2.players.length).toBe(10);

      // lobby-1 should NOT be in either team
      const allLobbies = [...team1.lobbies, ...team2.lobbies];
      expect(allLobbies).not.toContain("lobby-1");

      // we never owned lobby-1's lock, so it must not be requeued here
      const requeued = mockRedis.zadd.mock.calls.map((call) => call[2] as string);
      expect(requeued).not.toContain("lobby-1");

      createMatchConfirmationSpy.mockRestore();
    });
  });

  describe("lobby locks", () => {
    const region = "us-east";
    const type: e_match_types_enum = "Competitive";

    const soloLobbies = (count: number, rank = 1000): MatchmakingLobby[] =>
      Array.from({ length: count }, (_, i) => ({
        lobbyId: `lobby-${i + 1}`,
        type,
        regions: [region],
        players: [{ steam_id: `steam-${i + 1}`, rank }],
        avgRank: rank,
        joinedAt: new Date(),
        regionPositions: {},
      }));

    it("requeues every claimed but unused lobby exactly once", async () => {
      const lobbies = soloLobbies(12);
      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) =>
          lobbies.find((l) => l.lobbyId === lobbyId) || null,
      );

      const createMatchConfirmationSpy = jest
        .spyOn(service as any, "createMatchConfirmation")
        .mockResolvedValue(undefined);

      await (service as any).createMatches(region, type, lobbies);

      const { team1, team2 } = createMatchConfirmationSpy.mock.calls[0][2] as ConfirmationTeams;
      const matched = new Set([...team1.lobbies, ...team2.lobbies]);
      const requeued = mockRedis.zadd.mock.calls.map((call) => call[2] as string);

      // matched lobbies keep their lock, the confirmation owns them
      for (const lobbyId of matched) {
        expect(requeued).not.toContain(lobbyId);
      }

      // the other two are released, once each (one zadd per region key)
      for (const lobby of lobbies) {
        if (matched.has(lobby.lobbyId)) {
          continue;
        }
        expect(
          requeued.filter((id) => id === lobby.lobbyId),
        ).toHaveLength(2);
      }

      createMatchConfirmationSpy.mockRestore();
    });

    it("leaks no locks when creating the confirmation throws", async () => {
      const lobbies = soloLobbies(12);
      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) =>
          lobbies.find((l) => l.lobbyId === lobbyId) || null,
      );

      const createMatchConfirmationSpy = jest
        .spyOn(service as any, "createMatchConfirmation")
        .mockRejectedValue(new Error("redis is down"));

      const result = await (service as any).createMatches(
        region,
        type,
        lobbies,
      );

      const requeued = new Set(
        mockRedis.zadd.mock.calls.map((call) => call[2] as string),
      );
      for (const lobby of lobbies) {
        expect(requeued.has(lobby.lobbyId)).toBe(true);
      }
      expect(result).toBe(12);

      createMatchConfirmationSpy.mockRestore();
    });

    it("claims nothing when the party sizes can never fill two lineups", async () => {
      // five duos is ten players, but 2s cannot sum to a lineup of 5
      const lobbies: MatchmakingLobby[] = Array.from(
        { length: 5 },
        (_, i) => ({
          lobbyId: `duo-${i + 1}`,
          type,
          regions: [region],
          players: [
            { steam_id: `steam-${i * 2 + 1}`, rank: 1000 },
            { steam_id: `steam-${i * 2 + 2}`, rank: 1000 },
          ],
          avgRank: 1000,
          joinedAt: new Date(),
          regionPositions: {},
        }),
      );

      const createMatchConfirmationSpy = jest
        .spyOn(service as any, "createMatchConfirmation")
        .mockResolvedValue(undefined);

      const result = await (service as any).createMatches(
        region,
        type,
        lobbies,
      );

      expect(createMatchConfirmationSpy).not.toHaveBeenCalled();
      expect(mockRedis.eval).not.toHaveBeenCalled();
      // 0 so the caller does not spin retrying something that cannot resolve
      expect(result).toBe(0);

      createMatchConfirmationSpy.mockRestore();
    });

    it("does not mutate the lobbies it was given", async () => {
      const lobbies = soloLobbies(12);
      const snapshot = [...lobbies];
      mockMatchmakingLobbyService.getLobbyDetails.mockImplementation(
        async (lobbyId: string) =>
          lobbies.find((l) => l.lobbyId === lobbyId) || null,
      );

      const createMatchConfirmationSpy = jest
        .spyOn(service as any, "createMatchConfirmation")
        .mockResolvedValue(undefined);

      await (service as any).createMatches(region, type, lobbies);

      expect(lobbies).toEqual(snapshot);

      createMatchConfirmationSpy.mockRestore();
    });
  });

  describe("releaseLobbyAndRequeue", () => {
    it("should release the lock and re-add lobby to all regional queues", async () => {
      const lobby: MatchmakingLobby = {
        lobbyId: "lobby-requeue",
        type: "Competitive",
        regions: ["us-east", "eu-west"],
        players: [{ steam_id: "steam-1", rank: 1000 }],
        avgRank: 1000,
        joinedAt: new Date(),
        regionPositions: {},
      };

      mockMatchmakingLobbyService.getLobbyDetails.mockResolvedValue(lobby);

      await (service as any).releaseLobbyAndRequeue("lobby-requeue");

      // Verify lock was released (expire with 0)
      expect(mockRedis.expire).toHaveBeenCalledWith(
        "matchmaking:lock:lobby-requeue",
        0,
      );

      // Verify lobby was re-added to both regional queues
      // 2 regions * 2 keys each (queue + rank) = 4 zadd calls
      const zaddCalls = mockRedis.zadd.mock.calls;
      expect(zaddCalls.length).toBe(4);
      const zaddKeys = zaddCalls.map((c) => c[0]);
      expect(zaddKeys.some((k: string) => k.includes("us-east"))).toBe(true);
      expect(zaddKeys.some((k: string) => k.includes("eu-west"))).toBe(true);
    });
  });
});
