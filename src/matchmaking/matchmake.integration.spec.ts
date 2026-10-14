import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { e_match_types_enum, GenqlError } from "generated";
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
import { CacheService } from "../cache/cache.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MatchmakingQueues } from "./enums/MatchmakingQueues";
import { FakeRedis } from "./testing/fakeRedis";
import {
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";

const COMPETITIVE: e_match_types_enum = "Competitive";
const QUEUE_TYPES: e_match_types_enum[] = [
  "Duel",
  "Wingman",
  "Rush",
  "Competitive",
];

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
  // one entry per insert_match_lineup_players mutation
  let lineupInserts: Array<Array<{ lineupId: string; steamId: string }>>;
  let matchAssistant: {
    createMatchBasedOnType: jest.Mock;
    updateMatchStatus: jest.Mock;
  };
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let lobbyService: MatchmakingLobbyService;
  let queue: { add: jest.Mock; remove: jest.Mock };
  // players whose is_in_another_match reads true
  let busy: Set<string>;
  // players banned since they queued
  let banned: Set<string>;
  // the matches table: id to status
  let matchRows: Map<string, string>;

  beforeEach(async () => {
    redis = new FakeRedis();
    lobbyStore = new Map();
    confirmations = [];
    busy = new Set();
    banned = new Set();
    matchRows = new Map();

    queue = { add: jest.fn(), remove: jest.fn() };

    confirmationIds = [];
    lineupInserts = [];

    matchAssistant = {
      createMatchBasedOnType: jest.fn(async () => {
        matchRows.set("match-1", "PickingPlayers");
        return {
          id: "match-1",
          lineup_1_id: "lineup-1",
          lineup_2_id: "lineup-2",
        };
      }),
      updateMatchStatus: jest.fn(async (matchId: string, status: string) => {
        matchRows.set(matchId, status);
      }),
    };

    hasura = {
      query: jest.fn(async (payload: any) => {
        if (payload?.matches_by_pk) {
          return {
            matches_by_pk: {
              id: payload.matches_by_pk.__args.id,
              status: "Live",
            },
          };
        }
        if (payload?.players) {
          const steamIds: string[] = payload.players.__args.where.steam_id._in;
          return {
            players: steamIds
              .filter((steamId) => busy.has(steamId))
              .map((steamId) => ({
                steam_id: steamId,
                name: `name-${steamId}`,
              })),
          };
        }
        // sendRegionStats reads the region list on cancel
        return {
          server_regions: [{ value: "us-east" }, { value: "eu-west" }],
        };
      }),
      mutation: jest.fn(async (payload: any) => {
        if (payload?.delete_matches_by_pk) {
          matchRows.delete(payload.delete_matches_by_pk.__args.id);
        }
        if (payload?.delete_matches) {
          const { id, status } = payload.delete_matches.__args.where;
          if (!status || matchRows.get(id._eq) === status._eq) {
            matchRows.delete(id._eq);
          }
        }
        const objects = payload?.insert_match_lineup_players?.__args?.objects;
        if (objects) {
          lineupInserts.push(
            objects.map((o: any) => ({
              lineupId: o.match_lineup_id,
              steamId: o.steam_id,
            })),
          );
        }
        return {};
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: Logger, useValue: new Logger("Test") },
        MatchmakeService,
        CacheService,
        MatchmakingLobbyService,
        { provide: HasuraService, useValue: hasura },
        { provide: MatchAssistantService, useValue: matchAssistant },
        {
          provide: RedisManagerService,
          useValue: { getConnection: () => redis },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyMatchFound: jest.fn().mockResolvedValue(0),
            retractMatchFound: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: `BullQueue_${MatchmakingQueues.Matchmaking}`,
          useValue: queue as unknown as Queue,
        },
      ],
    }).compile();

    service = module.get<MatchmakeService>(MatchmakeService);
    lobbyService = module.get<MatchmakingLobbyService>(MatchmakingLobbyService);

    // A player's lobby as the database has it: the one they queued in.
    jest
      .spyOn(lobbyService, "getPlayerLobby")
      .mockImplementation(async (steamId: string) => {
        const lobby = [...lobbyStore.values()].find(({ players }) =>
          players.some((player) => player.steam_id === steamId),
        );
        return {
          id: lobby?.lobbyId ?? steamId,
          players: (lobby?.players ?? [{ steam_id: steamId }]).map(
            (player, index) => ({
              captain: index === 0,
              name: `name-${player.steam_id}`,
              steam_id: player.steam_id,
              is_banned: banned.has(player.steam_id),
              matchmaking_cooldown: false,
            }),
          ),
        };
      });

    const stamp =
      lobbyService.setMatchConformationIdForLobby.bind(lobbyService);
    jest
      .spyOn(lobbyService, "setMatchConformationIdForLobby")
      .mockImplementation(async (lobbyId: string, confirmationId: string) => {
        if (!confirmationIds.includes(confirmationId)) {
          confirmationIds.push(confirmationId);
        }
        return stamp(lobbyId, confirmationId);
      });

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
      await redis.hset(
        getMatchmakingLobbyDetailsCacheKey(lobby.lobbyId),
        "details",
        JSON.stringify(lobby),
      );
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

  function detailsOf(lobbyId: string) {
    return redis.hget(getMatchmakingLobbyDetailsCacheKey(lobbyId), "details");
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

  describe("region stats", () => {
    function lastRegionStats() {
      const published = redis.published
        .filter((entry) => entry.channel === "broadcast-message")
        .map((entry) => JSON.parse(entry.message))
        .filter((message) => message.event === "matchmaking:region-stats");

      return published.at(-1)?.data;
    }

    it("counts queued players, not lobbies", async () => {
      await enqueue([
        makeLobby("trio", [5000, 5000, 5000]),
        makeLobby("solo", [5000]),
      ]);

      await service.sendRegionStats();

      const queued = lastRegionStats()["us-east"][COMPETITIVE];
      const players = queued.reduce(
        (total: number, lobby: { players: number }) => total + lobby.players,
        0,
      );

      // a party of three is three people waiting for a game, not one
      expect(players).toBe(4);
    });

    it("counts a multi region lobby once", async () => {
      await enqueue([
        makeLobby("duo", [5000, 5000], { regions: ["us-east", "eu-west"] }),
      ]);

      await service.sendRegionStats();

      const stats = lastRegionStats();
      const east = stats["us-east"][COMPETITIVE];
      const west = stats["eu-west"][COMPETITIVE];

      // the same lobby index in both regions is what lets the client dedupe it
      expect(east[0].lobby).toBe(west[0].lobby);
      expect(east[0].players).toBe(2);
    });

    it("drops a queue entry whose lobby details are gone", async () => {
      await enqueue([makeLobby("ghost", [5000]), makeLobby("real", [5000])]);

      // a lobby can be left in the sorted set with no details behind it: a
      // leave that lands between reading the details and the zadd of a rejoin
      lobbyStore.delete("ghost");
      await redis.del(getMatchmakingLobbyDetailsCacheKey("ghost"));

      await service.sendRegionStats();

      const queued = lastRegionStats()["us-east"][COMPETITIVE];
      expect(queued).toHaveLength(1);

      // and it is swept out of the queue rather than counted forever
      expect(
        redis.members(getMatchmakingQueueCacheKey(COMPETITIVE, "us-east")),
      ).toEqual(["real"]);
    });

    function playCount(region = "us-east") {
      return (lastRegionStats()?.[region]?.[COMPETITIVE] ?? []).reduce(
        (total: number, lobby: { players: number }) => total + lobby.players,
        0,
      );
    }

    it("drops matched players from the Play count once a match is found", async () => {
      await enqueue(
        Array.from({ length: 13 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      );
      await service.sendRegionStats();
      expect(playCount()).toBe(13);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(playCount()).toBe(3);
    });

    it("drops a full party from the Play count once its match is found", async () => {
      await enqueue([makeLobby("ten-stack", new Array(10).fill(5000))]);
      await service.sendRegionStats();
      expect(playCount()).toBe(10);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(playCount()).toBe(0);
    });

    it("keeps the ready check when the Play count cannot be sent", async () => {
      const lobbies = Array.from({ length: 10 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000]),
      );
      await enqueue(lobbies);
      const answer = hasura.query.getMockImplementation();
      hasura.query.mockImplementation(async (payload: any) => {
        if (payload?.server_regions) {
          throw new Error("hasura unavailable");
        }
        return answer(payload);
      });

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).toHaveLength(0);
      expect(queue.add).toHaveBeenCalledWith(
        "CancelMatchMaking",
        expect.anything(),
        expect.anything(),
      );
      assertInvariants(lobbies);
    });

    function regionStatsBroadcasts() {
      return redis.published.filter(
        (entry) =>
          entry.channel === "broadcast-message" &&
          JSON.parse(entry.message).event === "matchmaking:region-stats",
      ).length;
    }

    // Another region's pass takes "multi" between this pass reading the queue
    // and claiming it, so this pass claims the rest, cannot field a match, and
    // puts them back. A broadcast made while it held them missed them all.
    it("re-counts lobbies a pass claimed and put back without a match", async () => {
      await enqueue([
        makeLobby("multi", [5000], {
          regions: ["us-east", "eu-west"],
          waitSeconds: 120,
        }),
        ...Array.from({ length: 9 }, (_, i) =>
          makeLobby(`west-${i}`, [5000], { regions: ["eu-west"] }),
        ),
      ]);

      const read = lobbyService.getLobbyDetails.bind(lobbyService);
      let takenByEast = false;
      jest
        .spyOn(lobbyService, "getLobbyDetails")
        .mockImplementation(async (lobbyId: string) => {
          const lobby = await read(lobbyId);
          if (lobbyId === "multi" && !takenByEast) {
            takenByEast = true;
            await (service as any).claimLobby("multi", lobby);
          }
          return lobby;
        });

      const expire = redis.expire.bind(redis);
      let broadcastWhileHeld = false;
      jest
        .spyOn(redis, "expire")
        .mockImplementation(async (key: string, seconds: number) => {
          if (!broadcastWhileHeld && seconds === 0) {
            broadcastWhileHeld = true;
            await service.sendRegionStats();
            expect(playCount("eu-west")).toBe(0);
          }
          return expire(key, seconds);
        });

      await service.matchmake(COMPETITIVE, "eu-west");

      expect(broadcastWhileHeld).toBe(true);
      expect(confirmations).toHaveLength(0);
      expect(queuedIn("eu-west")).toHaveLength(9);
      expect(playCount("eu-west")).toBe(9);
    });

    it("sends the Play count once for a pass that matches a party and a queue", async () => {
      await enqueue([
        makeLobby("ten-stack", new Array(10).fill(5000)),
        ...Array.from({ length: 10 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      ]);
      const before = regionStatsBroadcasts();

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(2);
      expect(regionStatsBroadcasts() - before).toBe(1);
      expect(playCount()).toBe(0);
    });

    it("keeps a lobby that rejoins while the stats are being built", async () => {
      await enqueue([makeLobby("rejoiner", [5000])]);

      jest
        .spyOn(lobbyService, "getLobbyDetails")
        .mockImplementationOnce(async (lobbyId: string) => {
          // the lobby leaves and comes straight back while we are reading it
          const rejoined = makeLobby("rejoiner", [5000]);
          lobbyStore.set("rejoiner", rejoined);
          await redis.hset(
            getMatchmakingLobbyDetailsCacheKey(lobbyId),
            "details",
            JSON.stringify(rejoined),
          );
          return null;
        });

      await service.sendRegionStats();

      // the sweep must not take the fresh entry down with the stale read
      expect(
        redis.members(getMatchmakingQueueCacheKey(COMPETITIVE, "us-east")),
      ).toEqual(["rejoiner"]);
    });
  });

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
      expect(
        await redis.get("matchmaking:lock:us-east:Competitive"),
      ).toBeNull();

      const second = Array.from({ length: 10 }, (_, i) =>
        makeLobby(`second-${i}`, [5000]),
      );
      await enqueue(second);
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(2);
    });

    it("releases the region lock once when the pass leaves players unmatched", async () => {
      await enqueue(
        Array.from({ length: 4 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      );
      const release = jest.spyOn(service as any, "releaseMatchmakeRegionLock");

      await service.matchmake(COMPETITIVE, "us-east");

      expect(release).toHaveBeenCalledTimes(1);
    });

    it("leaves the region lock alone once another pass has taken it", async () => {
      const regionLock = "matchmaking:lock:us-east:Competitive";
      await enqueue(
        Array.from({ length: 4 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      );

      // this pass outlives its lock, and another pass takes the region
      const createMatches = (service as any).createMatches.bind(service);
      jest
        .spyOn(service as any, "createMatches")
        .mockImplementation(async (...args: unknown[]) => {
          const unmatched = await createMatches(...args);
          redis.advanceTime(61_000);
          await redis.set(regionLock, "another-pass", "EX", 60, "NX");
          return unmatched;
        });

      await service.matchmake(COMPETITIVE, "us-east");

      expect(await redis.get(regionLock)).toBe("another-pass");
    });
  });

  describe("matches per pass", () => {
    it("drains three matches out of a thirty player queue in one pass", async () => {
      const lobbies = Array.from({ length: 30 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000 + (i % 5) * 10]),
      );
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(3);
      expect(queuedIn("us-east")).toHaveLength(0);
      assertInvariants(lobbies);
    });

    it("matches what it can and leaves the remainder queued", async () => {
      const lobbies = Array.from({ length: 25 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000]),
      );
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(2);
      expect(queuedIn("us-east")).toHaveLength(5);
      assertInvariants(lobbies);
    });

    it("keeps unused lobbies claimed between matches instead of churning them", async () => {
      const lobbies = Array.from({ length: 23 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000]),
      );
      await enqueue(lobbies);

      const requeuedBefore = redis.zaddCount();
      await service.matchmake(COMPETITIVE, "us-east");

      // two matches leave 3 lobbies over. releasing and re-claiming the
      // spares between iterations would requeue them - and push a redundant
      // queue update to every one of them - so each should be written back
      // once per region key, at the end, and no more.
      const leftover = queuedIn("us-east");
      expect(leftover).toHaveLength(3);
      expect(redis.zaddCount() - requeuedBefore).toBe(leftover.length * 2);
    });

    it("schedules one deduplicated pass when lobbies could not be claimed", async () => {
      const lobbies = Array.from({ length: 20 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000]),
      );
      await enqueue(lobbies);

      // everything is already locked by another worker, so nothing can be
      // claimed and the pass has to be retried later
      for (const lobby of lobbies) {
        await redis.set(`matchmaking:lock:${lobby.lobbyId}`, 1, "EX", 10, "NX");
      }

      await service.matchmake(COMPETITIVE, "us-east");

      const expandJobs = queue.add.mock.calls.filter(
        ([name]) => name === "ExpandMatchmaking",
      );
      expect(expandJobs).toHaveLength(1);

      // a fixed jobId so concurrent callers collapse into one pending pass
      // instead of stacking timers
      expect(expandJobs[0][2]).toMatchObject({
        jobId: "matchmaking.expand.Competitive.us-east",
      });
      expect(expandJobs[0][1]).toEqual({
        type: COMPETITIVE,
        region: "us-east",
        failures: 0,
      });
    });

    it("does not schedule another pass once the queue is drained", async () => {
      await enqueue(
        Array.from({ length: 10 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      );

      await service.matchmake(COMPETITIVE, "us-east");

      expect(
        queue.add.mock.calls.filter(([name]) => name === "ExpandMatchmaking"),
      ).toHaveLength(0);
    });

    it("stops carving when the remainder cannot legally split", async () => {
      // the duos sit outside the rank window of the long waiting solos, so the
      // first match is the ten solos and the remainder is five duos - ten
      // players that can never make two teams of five
      const lobbies = [
        ...Array.from({ length: 10 }, (_, i) =>
          makeLobby(`solo-${i}`, [5000], { waitSeconds: 300 }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          makeLobby(`duo-${i}`, [9600, 9600], { waitSeconds: 5 }),
        ),
      ];
      await enqueue(lobbies);

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east").sort()).toEqual([
        "duo-0",
        "duo-1",
        "duo-2",
        "duo-3",
        "duo-4",
      ]);
      assertInvariants(lobbies);
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

      // both teams go in at once, each team's players in its own lineup, and
      // nobody is duplicated
      expect(lineupInserts).toHaveLength(1);
      const [rows] = lineupInserts;
      const seatedIn = (lineupId: string) =>
        rows
          .filter((row) => row.lineupId === lineupId)
          .map((row) => row.steamId)
          .sort();
      expect(seatedIn("lineup-1")).toEqual(
        confirmation.team1.players.map((p) => p.steam_id).sort(),
      );
      expect(seatedIn("lineup-2")).toEqual(
        confirmation.team2.players.map((p) => p.steam_id).sort(),
      );
      expect(new Set(rows.map((row) => row.steamId)).size).toBe(10);
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

    it("creates one match when the last players confirm at the same moment", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      const [confirmation] = confirmations;
      const [confirmationId] = confirmationIds;
      const players = [
        ...confirmation.team1.players,
        ...confirmation.team2.players,
      ];

      for (const player of players.slice(0, 8)) {
        await service.playerConfirmMatchmaking(confirmationId, player.steam_id);
      }

      // the last two confirmations land together: both see a full lobby
      await Promise.all(
        players
          .slice(8)
          .map((player) =>
            service.playerConfirmMatchmaking(confirmationId, player.steam_id),
          ),
      );

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      expect(lineupInserts).toHaveLength(1);
    });

    it("does not create a second match when a player confirms twice", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      const { confirmation, confirmationId } = await confirmAll();

      // the client re-sends matchmaking:confirm - the match already exists, so
      // this must be a no-op rather than a second match for the same players
      await service.playerConfirmMatchmaking(
        confirmationId,
        confirmation.team1.players[0].steam_id,
      );

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
    });

    it("ignores a confirmation from a player who is not in the match", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      const [confirmation] = confirmations;
      const [confirmationId] = confirmationIds;
      const players = [
        ...confirmation.team1.players,
        ...confirmation.team2.players,
      ];

      // nine of the ten ready up, and a stranger sends the tenth confirmation
      for (const player of players.slice(0, 9)) {
        await service.playerConfirmMatchmaking(confirmationId, player.steam_id);
      }
      await service.playerConfirmMatchmaking(confirmationId, "not-in-match");

      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
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

    it.each([
      ["making the match", "createMatchBasedOnType"],
      ["adding its players", "insert_match_lineup_players"],
      ["starting it", "updateMatchStatus"],
    ])(
      "deletes the match and puts every lobby back where it was when %s fails",
      async (_, step) => {
        const lobbies = tenSolos();
        await enqueue(lobbies);
        await service.matchmake(COMPETITIVE, "us-east");
        const [confirmationId] = confirmationIds;
        const key = getMatchmakingConformationCacheKey(confirmationId);

        const failure = new Error("hasura unavailable");
        if (step === "insert_match_lineup_players") {
          const answer = hasura.mutation.getMockImplementation();
          hasura.mutation.mockImplementation(async (payload: any) => {
            if (payload?.insert_match_lineup_players) {
              throw failure;
            }
            return answer(payload);
          });
        } else {
          (matchAssistant as Record<string, jest.Mock>)[
            step
          ].mockRejectedValueOnce(failure);
        }

        await expect(confirmAll()).rejects.toThrow("hasura unavailable");

        expect([...matchRows.keys()]).toEqual([]);

        // every player accepted, so every lobby goes back with its place
        expect(queuedIn("us-east")).toEqual(
          lobbies.map((lobby) => lobby.lobbyId).sort(),
        );
        for (const lobby of lobbies) {
          expect(JSON.parse(await detailsOf(lobby.lobbyId)).joinedAt).toBe(
            lobby.joinedAt.toISOString(),
          );
          expect(
            await redis.hget(
              getMatchmakingLobbyDetailsCacheKey(lobby.lobbyId),
              "confirmationId",
            ),
          ).toBeNull();
          expect(
            await redis.get(`matchmaking:lock:${lobby.lobbyId}`),
          ).toBeNull();
        }
        expect(redis.has(key)).toBe(false);
        expect(redis.has(`${key}:confirmed`)).toBe(false);
        expect(redis.has(`${key}:creating`)).toBe(false);
      },
    );

    const refusal = (message: string) =>
      new GenqlError([{ message, extensions: { code: "data-exception" } }], {});

    const errorsTo = (steamId: string) =>
      redis.published
        .filter(({ channel }) => channel === "send-message-to-steam-id")
        .map(({ message }) => JSON.parse(message))
        .filter(
          (message) =>
            message.event === "matchmaking:error" &&
            message.steamId === steamId,
        )
        .map((message) => message.data);

    it("drops the lobby of a player banned since queueing instead of making the same match again", async () => {
      const lobbies = tenSolos();
      await enqueue(lobbies);
      await service.matchmake(COMPETITIVE, "us-east");

      banned.add("solo-3-p0");
      const answer = hasura.mutation.getMockImplementation();
      hasura.mutation.mockImplementation(async (payload: any) => {
        if (payload?.insert_match_lineup_players) {
          throw refusal("Player is Currently Banned");
        }
        return answer(payload);
      });

      await expect(confirmAll()).rejects.toThrow("Player is Currently Banned");

      expect(await detailsOf("solo-3")).toBeNull();
      expect(errorsTo("solo-3-p0")).toEqual([
        { code: "not_requeued", message: "name-solo-3-p0 is banned" },
      ]);
      expect(queuedIn("us-east")).toEqual(
        lobbies
          .map((lobby) => lobby.lobbyId)
          .filter((lobbyId) => lobbyId !== "solo-3")
          .sort(),
      );
      expect([...matchRows.keys()]).toEqual([]);

      confirmations.length = 0;
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toEqual([]);
    });

    it("drops every lobby when the database refuses the match for none of them", async () => {
      const lobbies = tenSolos();
      await enqueue(lobbies);
      await service.matchmake(COMPETITIVE, "us-east");

      matchAssistant.updateMatchStatus.mockRejectedValueOnce(
        refusal("No game servers are available in region us-east"),
      );

      await expect(confirmAll()).rejects.toThrow("No game servers");

      expect(queuedIn("us-east")).toEqual([]);
      for (const lobby of lobbies) {
        expect(await detailsOf(lobby.lobbyId)).toBeNull();
        expect(errorsTo(lobby.players[0].steam_id)).toEqual([
          {
            code: "match_refused",
            message: "No game servers are available in region us-east",
          },
        ]);
      }
      expect([...matchRows.keys()]).toEqual([]);
    });

    it("keeps a match that was started when the answer to starting it was lost", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      matchAssistant.updateMatchStatus.mockImplementationOnce(
        async (matchId: string, status: string) => {
          matchRows.set(matchId, status);
          throw new Error("socket hang up");
        },
      );

      await expect(confirmAll()).rejects.toThrow("socket hang up");

      expect(matchRows.get("match-1")).toBe("Live");
    });

    it("leaves the ready check to a creation still running when its cancel job fires", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");
      const [confirmationId] = confirmationIds;

      let finishCreating: () => void;
      const creating = new Promise<void>((reached) => {
        matchAssistant.createMatchBasedOnType.mockImplementationOnce(() => {
          reached();
          return new Promise((finish) => {
            finishCreating = () =>
              finish({
                id: "match-1",
                lineup_1_id: "lineup-1",
                lineup_2_id: "lineup-2",
              });
          });
        });
      });
      const accepted = confirmAll();
      await creating;

      await service.cancelMatchMaking(confirmationId);

      expect(queuedIn("us-east")).toEqual([]);
      for (let i = 0; i < 10; i++) {
        expect(
          await redis.hget(
            getMatchmakingLobbyDetailsCacheKey(`solo-${i}`),
            "confirmationId",
          ),
        ).toBe(confirmationId);
      }

      finishCreating();
      await accepted;

      expect(
        await redis.hget(
          getMatchmakingConformationCacheKey(confirmationId),
          "matchId",
        ),
      ).toBe("match-1");
      expect(queuedIn("us-east")).toEqual([]);
      for (let i = 0; i < 10; i++) {
        expect(await detailsOf(`solo-${i}`)).not.toBeNull();
      }
    });

    it("never puts the players of the match it made back in the queue", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");
      const { confirmationId } = await confirmAll();

      // a cancel job that could not be taken away in time
      await service.cancelMatchMaking(confirmationId);

      expect(queuedIn("us-east")).toEqual([]);
      for (let i = 0; i < 10; i++) {
        expect(
          await redis.hget(
            getMatchmakingLobbyDetailsCacheKey(`solo-${i}`),
            "confirmationId",
          ),
        ).toBe(confirmationId);
      }
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

      // everyone was ready, but the match could not be made
      matchAssistant.updateMatchStatus.mockRejectedValueOnce(
        new Error("hasura unavailable"),
      );
      await expect(confirmAll()).rejects.toThrow("hasura unavailable");

      expect(queuedIn("us-east")).toHaveLength(10);

      confirmations.length = 0;
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).toHaveLength(0);
    });
  });

  describe("players who are already in a match", () => {
    const tenSolos = (options?: { regions?: string[] }) =>
      Array.from({ length: 10 }, (_, i) =>
        makeLobby(`solo-${i}`, [5000], options),
      );

    function errorsTo(steamId: string) {
      return redis.published
        .filter((entry) => entry.channel === "send-message-to-steam-id")
        .map((entry) => JSON.parse(entry.message))
        .filter(
          (message) =>
            message.event === "matchmaking:error" &&
            message.steamId === steamId,
        )
        .map((message) => message.data);
    }

    async function confirmEveryone() {
      const [confirmation] = confirmations;
      const [confirmationId] = confirmationIds;
      for (const player of [
        ...confirmation.team1.players,
        ...confirmation.team2.players,
      ]) {
        await service.playerConfirmMatchmaking(confirmationId, player.steam_id);
      }
      return confirmationId;
    }

    function inAnyQueue(lobbyId: string, regions: string[]) {
      return QUEUE_TYPES.some((type) =>
        regions.some(
          (region) =>
            redis
              .members(getMatchmakingQueueCacheKey(type, region))
              .includes(lobbyId) ||
            redis
              .members(getMatchmakingRankCacheKey(type, region))
              .includes(lobbyId),
        ),
      );
    }

    it("drops a lobby whose player went into another match before the ready check", async () => {
      await enqueue(tenSolos());
      busy.add("solo-3-p0");

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(0);
      expect(queuedIn("us-east")).toHaveLength(9);
      expect(queuedIn("us-east")).not.toContain("solo-3");
      expect(await detailsOf("solo-3")).toBeNull();
      expect(errorsTo("solo-3-p0")).toEqual([
        expect.objectContaining({
          code: "player_in_match",
          name: "name-solo-3-p0",
        }),
      ]);
      expect(errorsTo("solo-4-p0")).toEqual([]);
    });

    it("drops a full party with a busy player instead of starting its ready check", async () => {
      await enqueue([makeLobby("ten-stack", new Array(10).fill(5000))]);
      busy.add("ten-stack-p7");

      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(0);
      expect(queuedIn("us-east")).toEqual([]);
      expect(await detailsOf("ten-stack")).toBeNull();
      expect(errorsTo("ten-stack-p0")).toEqual([
        expect.objectContaining({ code: "player_in_match" }),
      ]);
    });

    it("drops a lobby whose player went into another match before the match is created, and requeues the rest", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");
      expect(confirmations).toHaveLength(1);

      busy.add("solo-3-p0");
      const confirmationId = await confirmEveryone();

      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
      expect(lineupInserts).toEqual([]);
      expect(await detailsOf("solo-3")).toBeNull();
      expect(queuedIn("us-east")).toEqual(
        Array.from({ length: 10 }, (_, i) => `solo-${i}`)
          .filter((lobbyId) => lobbyId !== "solo-3")
          .sort(),
      );
      expect(
        await redis.hgetall(getMatchmakingConformationCacheKey(confirmationId)),
      ).toEqual({});
      expect(errorsTo("solo-3-p0")).toEqual([
        expect.objectContaining({ code: "player_in_match" }),
      ]);
    });

    it("takes the matched lobbies out of every queue when the match is created", async () => {
      const regions = ["us-east", "eu-west"];
      await enqueue(tenSolos({ regions }));
      await service.matchmake(COMPETITIVE, "us-east");

      // whatever put it back while the ready check was up
      await redis.zadd(
        getMatchmakingQueueCacheKey(COMPETITIVE, "eu-west"),
        0,
        "solo-0",
      );
      await redis.zadd(
        getMatchmakingRankCacheKey(COMPETITIVE, "eu-west"),
        5000,
        "solo-0",
      );
      await redis.zadd(
        getMatchmakingQueueCacheKey("Wingman", "us-east"),
        0,
        "solo-1",
      );
      await redis.zadd(
        getMatchmakingRankCacheKey("Wingman", "us-east"),
        5000,
        "solo-1",
      );

      await confirmEveryone();

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 10; i++) {
        expect(inAnyQueue(`solo-${i}`, regions)).toBe(false);
      }
    });

    it("still matches lobbies whose ready check failed part way", async () => {
      await enqueue(tenSolos());
      jest
        .spyOn(lobbyService, "sendQueueDetailsToLobby")
        .mockRejectedValueOnce(new Error("redis is down"));

      await service.matchmake(COMPETITIVE, "us-east");
      expect(queuedIn("us-east")).toHaveLength(10);

      // the failed ready check leaves nothing behind for the lobbies to show
      const [failedId] = confirmationIds;
      expect(
        await redis.hgetall(getMatchmakingConformationCacheKey(failedId)),
      ).toEqual({});
      for (let i = 0; i < 10; i++) {
        expect(
          await redis.hget(
            getMatchmakingLobbyDetailsCacheKey(`solo-${i}`),
            "confirmationId",
          ),
        ).toBeNull();
      }

      confirmations.length = 0;
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).toHaveLength(0);
    });

    it("does not claim a queued lobby that is still in a ready check", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");
      expect(confirmations).toHaveLength(1);

      // put back into the queue while its ready check is still up, and left
      // there past the 30s lobby lock
      await redis.zadd(
        getMatchmakingRankCacheKey(COMPETITIVE, "us-east"),
        5000,
        "solo-0",
      );
      await redis.zadd(
        getMatchmakingQueueCacheKey(COMPETITIVE, "us-east"),
        0,
        "solo-0",
      );
      redis.advanceTime(31_000);

      await enqueue(
        Array.from({ length: 9 }, (_, i) => makeLobby(`late-${i}`, [5000])),
      );
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).not.toContain("solo-0");
      expect(queuedIn("us-east")).toHaveLength(9);
    });

    it("lets the next pass claim the lobbies an aborted ready check put back", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      busy.add("solo-3-p0");
      await confirmEveryone();
      expect(queuedIn("us-east")).toHaveLength(9);

      // the follow-up pass runs within seconds, well inside the 30s lock the
      // ready check put on every lobby
      await enqueue([makeLobby("late-0", [5000])]);
      confirmations.length = 0;
      await service.matchmake(COMPETITIVE, "us-east");

      expect(confirmations).toHaveLength(1);
      expect(queuedIn("us-east")).toEqual([]);
    });

    it("keeps the ready check's cancel job when the abort cannot finish", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");
      const [confirmationId] = confirmationIds;

      busy.add("solo-3-p0");
      const answer = hasura.query.getMockImplementation();
      hasura.query.mockImplementation(async (payload: any) => {
        if (payload?.server_regions) {
          throw new Error("hasura unavailable");
        }
        return answer(payload);
      });

      await confirmEveryone().catch((): void => undefined);

      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
      expect(queue.remove).not.toHaveBeenCalledWith(
        `matchmaking.cancel.${confirmationId}`,
      );
    });

    it("never seats a player twice when they are in two queued lobbies", async () => {
      const solo = makeLobby("solo-x", [5000], { waitSeconds: 600 });
      const duo = makeLobby("duo-x", [5000, 5000], { waitSeconds: 600 });
      // queued solo, then pulled into a party before the solo entry is gone
      duo.players[0].steam_id = solo.players[0].steam_id;
      await enqueue([
        solo,
        duo,
        ...Array.from({ length: 8 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      ]);

      await service.matchmake(COMPETITIVE, "us-east");

      const seated = confirmations.flatMap((confirmation) =>
        [...confirmation.team1.players, ...confirmation.team2.players].map(
          (player) => player.steam_id,
        ),
      );
      expect(new Set(seated).size).toBe(seated.length);
    });

    it("releases the region when the Play count fails while dropping a stale entry", async () => {
      await enqueue(tenSolos());
      await service.matchmake(COMPETITIVE, "us-east");

      // put back while its ready check is still up
      await redis.zadd(
        getMatchmakingRankCacheKey(COMPETITIVE, "us-east"),
        5000,
        "solo-0",
      );
      await redis.zadd(
        getMatchmakingQueueCacheKey(COMPETITIVE, "us-east"),
        0,
        "solo-0",
      );

      const answer = hasura.query.getMockImplementation();
      hasura.query.mockImplementation(async (payload: any) => {
        if (payload?.server_regions) {
          throw new Error("hasura unavailable");
        }
        return answer(payload);
      });

      await expect(
        service.matchmake(COMPETITIVE, "us-east"),
      ).resolves.toBeUndefined();
      expect(
        await redis.get("matchmaking:lock:us-east:Competitive"),
      ).toBeNull();
      expect(queuedIn("us-east")).toEqual([]);
    });
  });

  describe("a pass that cannot check who is busy", () => {
    beforeEach(() => {
      const answer = hasura.query.getMockImplementation();
      hasura.query.mockImplementation(async (payload: any) => {
        if (payload?.players && lookupDown) {
          throw new Error("hasura unavailable");
        }
        return answer(payload);
      });
    });

    let lookupDown: boolean;

    it("claims nobody and asks for another pass, backing off to a cap", async () => {
      lookupDown = true;
      await enqueue(
        Array.from({ length: 10 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      );

      const delays: number[] = [];
      let failures = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const next = await service.matchmake(COMPETITIVE, "us-east", failures);
        delays.push(next.delay);
        failures = next.failures;
      }

      expect(confirmations).toEqual([]);
      expect(queuedIn("us-east")).toHaveLength(10);
      expect(delays).toEqual([
        10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
      ]);
      expect(
        await redis.get("matchmaking:lock:us-east:Competitive"),
      ).toBeNull();
    });

    it("matches as soon as the lookup is back", async () => {
      lookupDown = true;
      await enqueue(
        Array.from({ length: 10 }, (_, i) => makeLobby(`solo-${i}`, [5000])),
      );
      const { failures } = await service.matchmake(COMPETITIVE, "us-east", 4);

      lookupDown = false;
      const next = await service.matchmake(COMPETITIVE, "us-east", failures);

      expect(next).toBeUndefined();
      expect(confirmations).toHaveLength(1);
    });
  });

  describe("passes that collide and ready checks that end", () => {
    const solos = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeLobby(`${prefix}-${i}`, [5000]),
      );

    function regionStatsDown() {
      const answer = hasura.query.getMockImplementation();
      hasura.query.mockImplementation(async (payload: any) => {
        if (payload?.server_regions) {
          throw new Error("hasura unavailable");
        }
        return answer(payload);
      });
    }

    async function confirm(confirmationId: string, lobbyIds: string[]) {
      for (const lobbyId of lobbyIds) {
        for (const player of lobbyStore.get(lobbyId).players) {
          await service.playerConfirmMatchmaking(
            confirmationId,
            player.steam_id,
          );
        }
      }
    }

    // what matchmaking:leave does
    async function leave(lobbyId: string) {
      await service.releaseLobbyLock(lobbyId, 0);
      await lobbyService.removeLobbyFromQueue(lobbyId);
    }

    const stampOf = (lobbyId: string) =>
      redis.hget(getMatchmakingLobbyDetailsCacheKey(lobbyId), "confirmationId");

    const ids = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

    it("asks for another pass soon when the region is busy", async () => {
      await enqueue(solos("solo", 10));
      jest
        .spyOn(service as any, "aquireMatchmakeRegionLock")
        .mockResolvedValueOnce(false);

      const next = await service.matchmake(COMPETITIVE, "us-east", 3);

      expect(confirmations).toEqual([]);
      expect(next.failures).toBe(3);
      expect(next.delay).toBeGreaterThanOrEqual(1000);
      expect(next.delay).toBeLessThanOrEqual(5000);
      expect(queue.add).toHaveBeenCalledWith(
        "ExpandMatchmaking",
        { type: COMPETITIVE, region: "us-east", failures: 3 },
        expect.objectContaining({ delay: next.delay }),
      );
    });

    it("runs a pass for one type while another type's pass is stuck in the same region", async () => {
      await enqueue(solos("solo", 10));
      await enqueue(
        Array.from({ length: 4 }, (_, i) =>
          makeLobby(`wing-${i}`, [5000], { type: "Wingman" }),
        ),
      );

      let unstick: () => void;
      const stuck = new Promise<void>((resolve) => {
        unstick = resolve;
      });
      const answer = hasura.query.getMockImplementation();
      hasura.query.mockImplementation(async (payload: any) => {
        if (
          payload?.players?.__args.where.steam_id._in.some((steamId: string) =>
            steamId.startsWith("wing-"),
          )
        ) {
          await stuck;
        }
        return answer(payload);
      });

      const wingman = service.matchmake("Wingman", "us-east");
      await new Promise((resolve) => setImmediate(resolve));

      await service.matchmake(COMPETITIVE, "us-east");

      expect(
        confirmations.filter(({ type }) => type === COMPETITIVE),
      ).toHaveLength(1);

      unstick();
      await wingman;
    });

    it("leaves a lobby alone once it has moved on to a newer ready check", async () => {
      await enqueue(solos("first", 10));
      await service.matchmake(COMPETITIVE, "us-east");
      const [first] = confirmationIds;

      // first-0 accepts, leaves, queues again and lands in a second ready check
      await confirm(first, ["first-0"]);
      await leave("first-0");
      await enqueue([lobbyStore.get("first-0")]);
      await enqueue(solos("second", 9));
      await service.matchmake(COMPETITIVE, "us-east");
      const second = confirmationIds[1];
      expect(await stampOf("first-0")).toBe(second);

      await service.cancelMatchMaking(first);

      expect(await stampOf("first-0")).toBe(second);
      expect(queuedIn("us-east")).not.toContain("first-0");
      expect(await redis.get("matchmaking:lock:first-0")).not.toBeNull();
    });

    it("keeps a lobby that declined and queued again before the check ran out", async () => {
      await enqueue(solos("solo", 10));
      await service.matchmake(COMPETITIVE, "us-east");
      const [confirmationId] = confirmationIds;

      await leave("solo-0");
      await enqueue([lobbyStore.get("solo-0")]);

      await service.cancelMatchMaking(confirmationId);

      expect(queuedIn("us-east")).toEqual(["solo-0"]);
      expect(await detailsOf("solo-0")).not.toBeNull();
    });

    it("lets the cancel job finish an abort that failed part way, without the Play count", async () => {
      await enqueue(solos("solo", 10));
      await service.matchmake(COMPETITIVE, "us-east");
      const [confirmationId] = confirmationIds;

      busy.add("solo-3-p0");
      regionStatsDown();
      jest
        .spyOn(lobbyService, "removeLobbyDetails")
        .mockRejectedValueOnce(new Error("redis blipped"));

      await confirm(confirmationId, ids("solo", 10)).catch(
        (): void => undefined,
      );
      expect(queue.remove).not.toHaveBeenCalledWith(
        `matchmaking.cancel.${confirmationId}`,
      );

      // the cancel job, 30s later
      await service.cancelMatchMaking(confirmationId);

      expect(queuedIn("us-east")).toEqual(ids("solo", 10).sort());
      expect(
        await redis.hgetall(getMatchmakingConformationCacheKey(confirmationId)),
      ).toEqual({});
      for (const lobbyId of ids("solo", 10)) {
        expect(await stampOf(lobbyId)).toBeNull();
      }
    });

    it("retries the cancel job", async () => {
      await enqueue(solos("solo", 10));
      await service.matchmake(COMPETITIVE, "us-east");

      const [, , options] = queue.add.mock.calls.find(
        ([name]) => name === "CancelMatchMaking",
      );
      expect(options.attempts).toBeGreaterThan(1);
      expect(options.backoff).toEqual(
        expect.objectContaining({ type: "exponential" }),
      );
    });

    it("lets an abandoned ready check expire, but not the match it made", async () => {
      await enqueue(solos("solo", 10));
      await service.matchmake(COMPETITIVE, "us-east");
      const [confirmationId] = confirmationIds;
      const key = getMatchmakingConformationCacheKey(confirmationId);

      await confirm(confirmationId, ["solo-0"]);

      // long enough for the cancel job and all of its retries
      expect(await redis.ttl(key)).toBeGreaterThan(5 * 60);
      expect(await redis.ttl(`${key}:confirmed`)).toBeGreaterThan(5 * 60);

      await confirm(confirmationId, ids("solo", 10).slice(1));

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      expect(await redis.ttl(key)).toBe(-1);
      expect(await redis.ttl(`${key}:confirmed`)).toBe(-1);
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
        (lobbyService as any).redis = redis;
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
