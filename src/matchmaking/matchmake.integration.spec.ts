import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { e_match_types_enum } from "generated";
import { MatchmakingLobby } from "./types/MatchmakingLobby";

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
import { FakeRedis } from "./testing/fakeRedis";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";

const COMPETITIVE: e_match_types_enum = "Competitive";

/**
 * These drive the real MatchmakeService against an in-memory redis, so the
 * assertions are about the queue's actual end state rather than which mocks
 * were called. Matchmaking is a critical path: the failures that matter are a
 * lobby silently disappearing from the queue, a lobby landing in two matches,
 * or a team going out half full.
 */
describe("matchmaking (end to end)", () => {
  let service: MatchmakeService;
  let redis: FakeRedis;
  let lobbyStore: Map<string, MatchmakingLobby>;
  let confirmations: Array<{
    region: string;
    type: e_match_types_enum;
    team1: { lobbies: string[]; players: Array<{ steam_id: string; rank: number }> };
    team2: { lobbies: string[]; players: Array<{ steam_id: string; rank: number }> };
  }>;
  let confirmationIds: string[];
  let lineupInserts: Array<{ lineupId: string; steamIds: string[] }>;
  let matchAssistant: {
    createMatchBasedOnType: jest.Mock;
    updateMatchStatus: jest.Mock;
  };
  let hasura: { query: jest.Mock; mutation: jest.Mock };

  beforeEach(async () => {
    redis = new FakeRedis();
    lobbyStore = new Map();
    confirmations = [];

    // matchmake() reschedules itself when players are left over; the tests
    // drive each pass explicitly, so swallow the timer rather than leaving it
    // pending after the run
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation((() => 0) as unknown as typeof setTimeout);

    confirmationIds = [];
    lineupInserts = [];

    const lobbyService = {
      getLobbyDetails: jest.fn(async (lobbyId: string) => {
        const lobby = lobbyStore.get(lobbyId);
        return lobby ? { ...lobby, players: [...lobby.players] } : null;
      }),
      setMatchConformationIdForLobby: jest.fn(
        async (_lobbyId: string, confirmationId: string) => {
          if (!confirmationIds.includes(confirmationId)) {
            confirmationIds.push(confirmationId);
          }
        },
      ),
      sendQueueDetailsToLobby: jest.fn(),
      // the real implementations zrem from every region the lobby queued for
      removeLobbyFromQueue: jest.fn(async (lobbyId: string) => {
        const lobby = lobbyStore.get(lobbyId);
        for (const region of lobby?.regions ?? []) {
          await redis.zrem(
            getMatchmakingRankCacheKey(lobby.type, region),
            lobbyId,
          );
          await redis.zrem(
            getMatchmakingQueueCacheKey(lobby.type, region),
            lobbyId,
          );
        }
      }),
      removeLobbyDetails: jest.fn(async (lobbyId: string) => {
        lobbyStore.delete(lobbyId);
      }),
      removeConfirmationIdFromLobby: jest.fn(),
    };

    matchAssistant = {
      createMatchBasedOnType: jest.fn(async () => ({
        id: "match-1",
        lineup_1_id: "lineup-1",
        lineup_2_id: "lineup-2",
      })),
      updateMatchStatus: jest.fn(),
    };

    hasura = {
      // sendRegionStats reads the region list on cancel
      query: jest.fn(async () => ({
        server_regions: [{ value: "us-east" }, { value: "eu-west" }],
      })),
      mutation: jest.fn(async (payload: any) => {
        const objects = payload?.insert_match_lineup_players?.__args?.objects;
        if (objects) {
          lineupInserts.push({
            lineupId: objects[0]?.match_lineup_id,
            steamIds: objects.map((o: any) => o.steam_id),
          });
        }
        return {};
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: Logger, useValue: new Logger("Test") },
        MatchmakeService,
        { provide: HasuraService, useValue: hasura },
        { provide: MatchAssistantService, useValue: matchAssistant },
        { provide: MatchmakingLobbyService, useValue: lobbyService },
        {
          provide: RedisManagerService,
          useValue: { getConnection: () => redis },
        },
        {
          provide: `BullQueue_${MatchmakingQueues.Matchmaking}`,
          useValue: { add: jest.fn(), remove: jest.fn() } as unknown as Queue,
        },
      ],
    }).compile();

    service = module.get<MatchmakeService>(MatchmakeService);

    // record confirmations but keep the real redis writes, so queue state stays honest
    const original = (service as any).createMatchConfirmation.bind(service);
    jest
      .spyOn(service as any, "createMatchConfirmation")
      .mockImplementation(async (...args: any[]) => {
        const [region, type, teams] = args;
        confirmations.push({ region, type, ...teams });
        return original(region, type, teams);
      });
  });

  // --- helpers

  function makeLobby(
    lobbyId: string,
    ranks: number[],
    options?: { regions?: string[]; waitSeconds?: number; type?: e_match_types_enum },
  ): MatchmakingLobby {
    return {
      lobbyId,
      type: options?.type ?? COMPETITIVE,
      regions: options?.regions ?? ["us-east"],
      joinedAt: new Date(Date.now() - (options?.waitSeconds ?? 30) * 1000),
      players: ranks.map((rank, index) => ({
        steam_id: `${lobbyId}-p${index}`,
        rank,
      })),
      regionPositions: {},
      avgRank: ranks.reduce((acc, rank) => acc + rank, 0) / ranks.length,
    };
  }

  async function enqueue(lobbies: MatchmakingLobby[]) {
    for (const lobby of lobbies) {
      lobbyStore.set(lobby.lobbyId, lobby);
      for (const region of lobby.regions) {
        await redis.zadd(
          getMatchmakingRankCacheKey(lobby.type, region),
          lobby.avgRank,
          lobby.lobbyId,
        );
        await redis.zadd(
          getMatchmakingQueueCacheKey(lobby.type, region),
          0,
          lobby.lobbyId,
        );
      }
    }
  }

  function queuedIn(region: string, type = COMPETITIVE) {
    return redis.members(getMatchmakingRankCacheKey(type, region));
  }

  function matchedLobbies() {
    return confirmations.flatMap((c) => [...c.team1.lobbies, ...c.team2.lobbies]);
  }

  /** The invariants that must hold no matter what the queue looked like. */
  function assertInvariants(
    lobbies: MatchmakingLobby[],
    type: e_match_types_enum = COMPETITIVE,
  ) {
    const half = ExpectedPlayers[type] / 2;

    for (const confirmation of confirmations) {
      expect(confirmation.team1.players).toHaveLength(half);
      expect(confirmation.team2.players).toHaveLength(half);

      // a party is never split across the two teams
      const team1Lobbies = new Set(confirmation.team1.lobbies);
      for (const lobbyId of confirmation.team2.lobbies) {
        expect(team1Lobbies.has(lobbyId)).toBe(false);
      }

      // the players in a team are exactly the players of its lobbies
      for (const team of [confirmation.team1, confirmation.team2]) {
        const expected = team.lobbies.flatMap(
          (lobbyId) => lobbyStore.get(lobbyId).players,
        );
        expect(team.players.map((p) => p.steam_id).sort()).toEqual(
          expected.map((p) => p.steam_id).sort(),
        );
      }
    }

    // no lobby is in two matches
    const matched = matchedLobbies();
    expect(new Set(matched).size).toBe(matched.length);

    // no player is in two matches
    const players = confirmations.flatMap((c) => [
      ...c.team1.players,
      ...c.team2.players,
    ]);
    expect(new Set(players.map((p) => p.steam_id)).size).toBe(players.length);

    // conservation: every lobby is either matched or still queued, never lost
    const matchedSet = new Set(matched);
    for (const lobby of lobbies) {
      const stillQueued = lobby.regions.some((region) =>
        queuedIn(region, lobby.type).includes(lobby.lobbyId),
      );
      expect(matchedSet.has(lobby.lobbyId) !== stillQueued).toBe(true);
    }
  }

  // --- tests

  describe("queue state", () => {
    it("matches ten solo players and empties the queue", async () => {
      const lobbies = Array.from({ length: 10 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000 + i * 10]),
      );
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).toHaveLength(0);
      assertInvariants(lobbies);
    });

    it("leaves the surplus queued and requeues it intact", async () => {
      const lobbies = Array.from({ length: 13 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000]),
      );
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).toHaveLength(3);
      assertInvariants(lobbies);
    });

    it("does not touch the queue when there are not enough players", async () => {
      const lobbies = Array.from({ length: 9 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000]),
      );
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(0);
      expect(queuedIn("us-east")).toHaveLength(9);
      assertInvariants(lobbies);
    });

    it("keeps everyone queued when party sizes cannot fill two lineups", async () => {
      // five duos: ten players, but 2s never sum to a lineup of 5
      const lobbies = Array.from({ length: 5 }, (_, i) =>
        makeLobby(`duo-${i}`, [5000, 5000]),
      );
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(0);
      expect(queuedIn("us-east")).toHaveLength(5);
      assertInvariants(lobbies);
    });

    it("releases the region lock so a later pass can run", async () => {
      await enqueue(
        Array.from({ length: 10 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      );

      await service.matchmake(COMPETITIVE, "us-east");
      expect(await redis.get("matchmaking:lock:us-east")).toBeNull();

      const second = Array.from({ length: 10 }, (_, i) =>
        makeLobby(`second-${i}`, [5000]),
      );
      await enqueue(second);
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(2);
    });
  });

  describe("parties", () => {
    it("never splits a party across teams", async () => {
      const lobbies = [
        makeLobby("trio", [6000, 6000, 6000]),
        makeLobby("duo", [4000, 4000]),
        makeLobby("pair", [5000, 5000]),
        makeLobby("solo-1", [5000]),
        makeLobby("solo-2", [5000]),
        makeLobby("solo-3", [5000]),
      ];
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      assertInvariants(lobbies);
    });

    it("splits a full ten stack in house without touching the queue order", async () => {
      const party = makeLobby("ten-stack", new Array(10).fill(5000));
      await enqueue([party]);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      const [confirmation] = confirmations;
      expect(confirmation.team1.players).toHaveLength(5);
      expect(confirmation.team2.players).toHaveLength(5);

      // the lobby id is recorded once, not once per team, so the confirmation
      // does not process it twice on cancel
      expect([
        ...confirmation.team1.lobbies,
        ...confirmation.team2.lobbies,
      ]).toEqual(["ten-stack"]);
    });

    it("balances a wingman queue", async () => {
      const lobbies = [
        makeLobby("w1", [6000], { type: "Wingman" }),
        makeLobby("w2", [5000], { type: "Wingman" }),
        makeLobby("w3", [5000], { type: "Wingman" }),
        makeLobby("w4", [4000], { type: "Wingman" }),
      ];
      await enqueue(lobbies);

      await service.matchmake("Wingman", "us-east");

      expect(confirmations).toHaveLength(1);
      const [confirmation] = confirmations;
      const avg = (players: Array<{ rank: number }>) =>
        players.reduce((acc, p) => acc + p.rank, 0) / players.length;
      expect(
        Math.abs(avg(confirmation.team1.players) - avg(confirmation.team2.players)),
      ).toBe(0);
      assertInvariants(lobbies, "Wingman");
    });
  });

  describe("multi region", () => {
    it("removes a matched lobby from every region it queued for", async () => {
      const shared = makeLobby("shared", [5000], {
        regions: ["us-east", "eu-west"],
      });
      const lobbies = [
        shared,
        ...Array.from({ length: 9 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      ];
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(matchedLobbies()).toContain("shared");
      expect(queuedIn("us-east")).not.toContain("shared");
      expect(queuedIn("eu-west")).not.toContain("shared");
    });

    it("requeues an unused multi region lobby to all of its regions", async () => {
      // the solos have waited longer, so one of them anchors the match and the
      // window is measured from 5000, not from the outlier
      const shared = makeLobby("shared", [9000], {
        regions: ["us-east", "eu-west"],
        waitSeconds: 5,
      });
      const lobbies = [
        shared,
        ...Array.from({ length: 10 }, (_, i) =>
          makeLobby(`solo-${i}`, [5000], { waitSeconds: 60 }),
        ),
      ];
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      // the 9000 is out of the rank window, so it stays queued everywhere
      expect(matchedLobbies()).not.toContain("shared");
      expect(queuedIn("us-east")).toContain("shared");
      expect(queuedIn("eu-west")).toContain("shared");
    });

    it("matches a shared lobby only once when two regions run concurrently", async () => {
      const shared = makeLobby("shared", [5000], {
        regions: ["us-east", "eu-west"],
      });
      await enqueue([
        shared,
        ...Array.from({ length: 9 }, (_, i) =>
          makeLobby(`us-${i}`, [5000], { regions: ["us-east"] }),
        ),
        ...Array.from({ length: 9 }, (_, i) =>
          makeLobby(`eu-${i}`, [5000], { regions: ["eu-west"] }),
        ),
      ]);

      await Promise.all([
        service.matchmake(COMPETITIVE, "us-east"),
        service.matchmake(COMPETITIVE, "eu-west"),
      ]);

      const matched = matchedLobbies();
      expect(matched.filter((id) => id === "shared")).toHaveLength(1);
      expect(new Set(matched).size).toBe(matched.length);
    });
  });

  describe("balance quality", () => {
    it("beats the old greedy split on a queue greedy handles badly", async () => {
      const ranks = [
        6000, 5800, 5600, 5400, 5200, 5000, 4800, 4600, 4400, 1200,
      ];
      const lobbies = ranks.map((rank, i) => makeLobby(`solo-${i}`, [rank]));
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      const [confirmation] = confirmations;
      const avg = (players: Array<{ rank: number }>) =>
        players.reduce((acc, p) => acc + p.rank, 0) / players.length;

      // greedy produces a 1120 point gap on this exact queue
      expect(
        Math.abs(avg(confirmation.team1.players) - avg(confirmation.team2.players)),
      ).toBe(0);
    });

    it("leaves a freshly queued out of rank player out of the match", async () => {
      const lobbies = [
        makeLobby("smurf", [9500], { waitSeconds: 5 }),
        ...Array.from({ length: 10 }, (_, i) =>
          makeLobby(`solo-${i}`, [5000], { waitSeconds: 60 }),
        ),
      ];
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(matchedLobbies()).not.toContain("smurf");
      expect(queuedIn("us-east")).toContain("smurf");
    });

    it("eventually takes the out of rank player once they have waited", async () => {
      const lobbies = [
        makeLobby("smurf", [9500], { waitSeconds: 600 }),
        ...Array.from({ length: 9 }, (_, i) =>
          makeLobby(`solo-${i}`, [5000], { waitSeconds: 5 }),
        ),
      ];
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(matchedLobbies()).toContain("smurf");
    });

    it("plays the longest waiting lobby rather than starving it", async () => {
      const lobbies = [
        makeLobby("oldest", [5000], { waitSeconds: 900 }),
        ...Array.from({ length: 14 }, (_, i) =>
          makeLobby(`solo-${i}`, [5000], { waitSeconds: 5 }),
        ),
      ];
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(matchedLobbies()).toContain("oldest");
    });
  });

  describe("ready check", () => {
    const tenSolos = () =>
      Array.from({ length: 10 }, (_, i) => makeLobby(`solo-${i}`, [5000]));

    async function confirmAll() {
      const [confirmation] = confirmations;
      const [confirmationId] = confirmationIds;

      for (const player of [
        ...confirmation.team1.players,
        ...confirmation.team2.players,
      ]) {
        await service.playerConfirmMatchmaking(confirmationId, player.steam_id);
      }

      return { confirmation, confirmationId };
    }

    it("creates the match once every player has confirmed", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      const { confirmation } = await confirmAll();

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      expect(matchAssistant.updateMatchStatus).toHaveBeenCalledWith(
        "match-1",
        "Live",
      );

      // each team's players land in its own lineup, and nobody is duplicated
      expect(lineupInserts).toHaveLength(2);
      const [first, second] = lineupInserts;
      expect(first.lineupId).toBe("lineup-1");
      expect(second.lineupId).toBe("lineup-2");
      expect(first.steamIds.sort()).toEqual(
        confirmation.team1.players.map((p) => p.steam_id).sort(),
      );
      expect(second.steamIds.sort()).toEqual(
        confirmation.team2.players.map((p) => p.steam_id).sort(),
      );
      expect(new Set([...first.steamIds, ...second.steamIds]).size).toBe(10);
    });

    it("does not create the match until the last player confirms", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      const [confirmation] = confirmations;
      const [confirmationId] = confirmationIds;
      const players = [
        ...confirmation.team1.players,
        ...confirmation.team2.players,
      ];

      for (const player of players.slice(0, 9)) {
        await service.playerConfirmMatchmaking(confirmationId, player.steam_id);
      }
      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();

      await service.playerConfirmMatchmaking(
        confirmationId,
        players.at(-1).steam_id,
      );
      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
    });

    it("drops every lobby from the queue when nobody confirms", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      await service.cancelMatchMaking(confirmationIds[0]);

      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
      expect(queuedIn("us-east")).toHaveLength(0);
    });

    it("requeues only the lobbies whose players were all ready", async () => {
      const lobbies = [
        makeLobby("ready-duo", [5000, 5000]),
        ...Array.from({ length: 8 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      ];
      await enqueue(lobbies);
      await service.matchmake(COMPETITIVE, "us-east");

      const [confirmationId] = confirmationIds;

      // only the duo readies up
      for (const player of lobbyStore.get("ready-duo").players) {
        await service.playerConfirmMatchmaking(confirmationId, player.steam_id);
      }

      await service.cancelMatchMaking(confirmationId);

      // the duo goes back in the queue; everyone who ignored the ready check
      // is dropped out of matchmaking entirely
      expect(queuedIn("us-east")).toEqual(["ready-duo"]);
    });

    it("holds the lobby locks while the confirmation is pending", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      // a pending confirmation must keep its lobbies locked, otherwise a
      // concurrent pass could put the same players in a second match
      expect(await redis.get("matchmaking:lock:solo-0")).not.toBeNull();

      redis.advanceTime(31_000);
      expect(await redis.get("matchmaking:lock:solo-0")).toBeNull();
    });

    it("lets a requeued lobby be matched again on the next pass", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      const [confirmation] = confirmations;
      const [confirmationId] = confirmationIds;
      for (const player of [
        ...confirmation.team1.players,
        ...confirmation.team2.players,
      ]) {
        await service.playerConfirmMatchmaking(confirmationId, player.steam_id);
      }
      // everyone was ready, but the match was cancelled for another reason
      await service.cancelMatchMaking(confirmationId);

      expect(queuedIn("us-east")).toHaveLength(10);

      // the confirmation put a 30s ttl on each lobby lock; the next pass can
      // only claim them once that has lapsed
      redis.advanceTime(31_000);

      confirmations.length = 0;
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).toHaveLength(0);
    });
  });

  describe("randomized queues", () => {
    function mulberry32(seed: number) {
      let state = seed;
      return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it("holds every invariant across 60 random queues", async () => {
      const random = mulberry32(31337);

      for (let iteration = 0; iteration < 60; iteration++) {
        redis = new FakeRedis();
        (service as any).redis = redis;
        lobbyStore.clear();
        confirmations.length = 0;

        const lobbies: MatchmakingLobby[] = [];
        const lobbyCount = 2 + Math.floor(random() * 14);
        for (let i = 0; i < lobbyCount; i++) {
          const size = 1 + Math.floor(random() * 5);
          lobbies.push(
            makeLobby(
              `lobby-${i}`,
              Array.from(
                { length: size },
                () => 2000 + Math.floor(random() * 7000),
              ),
              { waitSeconds: 5 + Math.floor(random() * 600) },
            ),
          );
        }

        await enqueue(lobbies);
        await service.matchmake(COMPETITIVE, "us-east");

        assertInvariants(lobbies);
      }
    });
  });
});
