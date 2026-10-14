import { Logger } from "@nestjs/common";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { e_match_types_enum } from "generated";

jest.mock("../src/matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { MatchmakeService } from "../src/matchmaking/matchmake.service";
import { MatchmakingLobbyService } from "../src/matchmaking/matchmaking-lobby.service";
import { MatchmakingGateway } from "../src/matchmaking/matchmaking.gateway";
import { CacheService } from "../src/cache/cache.service";
import {
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "../src/matchmaking/utilities/cacheKeys";

const A = "76561198000000001";
const B = "76561198000000002";
const PARTY = "8a1c3f8e-3c55-4c55-9a8e-5c1f0f6b2a11";
const REGION = "us-east";

/**
 * The sweep is one compare-and-set script per lobby, so it runs against a real
 * redis: what it may touch is decided by what is in redis at that instant,
 * which no fake reproduces.
 */
describe("stranded matchmaking lobbies", () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let matchmake: MatchmakeService;
  let lobbies: MatchmakingLobbyService;
  let gateway: MatchmakingGateway;
  let queue: { add: jest.Mock; remove: jest.Mock };
  let published: Array<{ steamId: string; event: string; data: any }>;
  let broadcasts: string[];
  let createMatch: jest.Mock;
  // players whose is_in_another_match reads true
  let busy: Set<string>;
  // players who have joined a party since they queued alone
  let partyOf: Map<string, string>;
  let onBusyCheck: (steamIds: string[]) => Promise<void>;
  let onRegionStats: () => Promise<void>;
  let statsRegions: string[];

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });
  }, 120_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();

    published = [];
    broadcasts = [];
    busy = new Set();
    partyOf = new Map();
    onBusyCheck = async () => {};
    onRegionStats = async () => {};
    statsRegions = [REGION];
    createMatch = jest.fn(async () => ({
      id: "match-1",
      lineup_1_id: "lineup-1",
      lineup_2_id: "lineup-2",
    }));

    jest.spyOn(redis, "publish").mockImplementation((async (
      channel: string,
      message: string,
    ) => {
      if (channel === "send-message-to-steam-id") {
        published.push(JSON.parse(message));
      }
      if (channel === "broadcast-message") {
        broadcasts.push(JSON.parse(message).event);
      }
      return 0;
    }) as any);

    const player = (steam_id: string) => ({
      steam_id,
      name: `name-${steam_id}`,
      is_banned: false,
      matchmaking_cooldown: null as string | null,
    });

    const hasura = {
      query: jest.fn(async (payload: Record<string, any>) => {
        if (payload.settings) {
          return { settings: [] as Array<{ name: string; value: string }> };
        }
        if (payload.server_regions) {
          // the Play count's query; a join asks by status instead
          if (payload.server_regions.__args.where._and) {
            await onRegionStats();
            return {
              server_regions: statsRegions.map((value) => ({ value })),
            };
          }
          return {
            server_regions: [
              { value: REGION, is_lan: false, status: "Online" },
            ],
          };
        }
        if (payload.game_server_nodes_aggregate) {
          return { game_server_nodes_aggregate: { aggregate: { count: 0 } } };
        }
        if (payload.players_by_pk) {
          const steamId = payload.players_by_pk.__args.steam_id;
          return {
            players_by_pk: {
              ...player(steamId),
              current_lobby_id: partyOf.get(steamId) ?? null,
              is_in_another_match: busy.has(steamId),
            },
          };
        }
        if (payload.lobbies_by_pk) {
          const members = [...partyOf.entries()]
            .filter(
              ([, lobbyId]) => lobbyId === payload.lobbies_by_pk.__args.id,
            )
            .map(([steamId]) => steamId);
          return {
            lobbies_by_pk: {
              players: members.map((steam_id, index) => ({
                steam_id,
                captain: index === 0,
                player: player(steam_id),
              })),
            },
          };
        }
        if (payload.players?.__args.where.is_in_another_match) {
          const steamIds: string[] = payload.players.__args.where.steam_id._in;
          await onBusyCheck(steamIds);
          return {
            players: steamIds
              .filter((steamId) => busy.has(steamId))
              .map((steamId) => ({
                steam_id: steamId,
                name: `name-${steamId}`,
              })),
          };
        }
        if (payload.players) {
          return {
            players: payload.players.__args.where.steam_id._in.map(
              (steam_id: string) => ({ steam_id, elo: {} }),
            ),
          };
        }
        if (payload.matches_by_pk) {
          return {
            matches_by_pk: {
              id: payload.matches_by_pk.__args.id,
              status: "Live",
            },
          };
        }
        throw new Error(`unexpected query ${Object.keys(payload)}`);
      }),
      mutation: jest.fn(async () => ({})),
    };

    const logger = new Logger("StrandedLobbiesTest");
    const redisManager = { getConnection: () => redis };

    queue = { add: jest.fn(), remove: jest.fn() };

    lobbies = new MatchmakingLobbyService(
      logger,
      hasura as any,
      redisManager as any,
      undefined,
    );
    matchmake = new MatchmakeService(
      logger,
      hasura as any,
      redisManager as any,
      {
        createMatchBasedOnType: createMatch,
        updateMatchStatus: jest.fn(),
      } as any,
      lobbies,
      {
        notifyMatchFound: jest.fn().mockResolvedValue(0),
        retractMatchFound: jest.fn().mockResolvedValue(undefined),
      } as any,
      queue as any,
      new CacheService(redisManager as any, logger),
    );
    (lobbies as any).matchmaking = matchmake;

    // passes run when a test says so, not on every join
    jest.spyOn(matchmake, "matchmake").mockResolvedValue(undefined);

    gateway = new MatchmakingGateway(
      logger,
      hasura as any,
      redisManager as any,
      matchmake,
      lobbies,
      new CacheService(redisManager as any, logger),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const clientOf = (steamId: string) =>
    ({
      user: { steam_id: steamId, name: `name-${steamId}`, role: "user" },
      sessionId: `session-${steamId}`,
      authentication: Promise.resolve(),
    }) as any;

  const join = (steamId: string, type: e_match_types_enum = "Duel") =>
    gateway.joinQueue({ type, regions: [REGION] }, clientOf(steamId));

  const runPass = (type: e_match_types_enum = "Duel", region = REGION) =>
    MatchmakeService.prototype.matchmake.call(matchmake, type, region);

  // The process dies inside the pass: nothing after the claim ever runs.
  function freezePassAtConfirmation() {
    let reached: () => void;
    const atConfirmation = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const frozen = jest
      .spyOn(matchmake as any, "createMatchConfirmation")
      .mockImplementation(() => {
        reached();
        return new Promise(() => {});
      });

    void runPass();

    return { atConfirmation, frozen };
  }

  const regionLock = `matchmaking:lock:${REGION}:Duel`;
  const lobbyLock = (lobbyId: string) => `matchmaking:lock:${lobbyId}`;

  const queued = async (type: e_match_types_enum = "Duel", region = REGION) =>
    (
      await redis.zrange(getMatchmakingQueueCacheKey(type, region), 0, -1)
    ).sort();

  const ranked = async (type: e_match_types_enum = "Duel", region = REGION) =>
    (
      await redis.zrange(getMatchmakingRankCacheKey(type, region), 0, -1)
    ).sort();

  // What a requeue that raced the lobby's leave leaves behind.
  async function strayEntry(
    lobbyId: string,
    type: e_match_types_enum,
    region = REGION,
  ) {
    await redis.zadd(getMatchmakingQueueCacheKey(type, region), 0, lobbyId);
    await redis.zadd(getMatchmakingRankCacheKey(type, region), 5000, lobbyId);
  }

  const detailsOf = (lobbyId: string) =>
    redis.hget(getMatchmakingLobbyDetailsCacheKey(lobbyId), "details");

  const stampOf = (lobbyId: string) =>
    redis.hget(getMatchmakingLobbyDetailsCacheKey(lobbyId), "confirmationId");

  const readyChecks = (): string[] =>
    queue.add.mock.calls
      .filter(([name]) => name === "CancelMatchMaking")
      .map(([, { confirmationId }]) => confirmationId);

  const sentTo = (steamId: string, event: string) =>
    published.filter(
      (message) => message.steamId === steamId && message.event === event,
    );

  const errorCodes = (steamId: string) =>
    sentTo(steamId, "matchmaking:error").map((message) => message.data.code);

  async function confirm(confirmationId: string, steamId: string) {
    await matchmake.playerConfirmMatchmaking(confirmationId, steamId);
  }

  // Its ten minutes ran out before the cancel job got to it.
  async function expireReadyCheck(confirmationId: string) {
    const key = getMatchmakingConformationCacheKey(confirmationId);
    await redis.del(key, `${key}:confirmed`, lobbyLock(A), lobbyLock(B));
  }

  // The ready check ended this long ago, and a claim on creating its match,
  // which lasts ten minutes, was taken before it did.
  async function readyCheckExpired(confirmationId: string, secondsAgo: number) {
    const key = getMatchmakingConformationCacheKey(confirmationId);
    await redis.hset(
      key,
      "expiresAt",
      new Date(Date.now() - secondsAgo * 1000).toISOString(),
    );
    if (await redis.exists(`${key}:creating`)) {
      await redis.pexpire(`${key}:creating`, (10 * 60 - secondsAgo) * 1000);
    }
    await redis.del(lobbyLock(A), lobbyLock(B));
  }

  const sweep = () => matchmake.healStrandedLobbies();

  // What the sweep saw last time is a key that runs down, so a minute passing
  // is a minute off its ttl.
  async function aMinuteLater() {
    for (const key of await redis.keys("matchmaking:v20:stranded:*")) {
      await redis.pexpire(key, (await redis.pttl(key)) - 60_000);
    }
  }

  async function sweepTwice() {
    await sweep();
    await aMinuteLater();
    await sweep();
  }

  async function strandedByDeadPass() {
    await join(A);
    await join(B);

    const { atConfirmation, frozen } = freezePassAtConfirmation();
    await atConfirmation;
    expect(await queued()).toEqual([]);

    return frozen;
  }

  it("puts lobbies back in the queue when the pass that claimed them died", async () => {
    const frozen = await strandedByDeadPass();

    // the dead pod's locks run out
    await redis.del(regionLock, lobbyLock(A), lobbyLock(B));

    // unrelated keys, so the sweep has to page through the keyspace
    const filler = redis.pipeline();
    for (let index = 0; index < 2500; index++) {
      filler.set(`unrelated:${index}`, "1");
    }
    await filler.exec();

    await join(A);
    expect(errorCodes(A)).toEqual(["already_queued"]);

    await sweepTwice();

    expect(await queued()).toEqual([A, B]);
    expect(await ranked()).toEqual([A, B]);
    expect(sentTo(A, "matchmaking:details").at(-1).data.details).toMatchObject({
      lobbyId: A,
    });
    expect(queue.add).toHaveBeenCalledWith(
      "ExpandMatchmaking",
      expect.objectContaining({ type: "Duel", region: REGION }),
      expect.anything(),
    );

    frozen.mockRestore();
    await runPass();

    expect(readyChecks()).toHaveLength(1);
    expect(await stampOf(A)).toBe(readyChecks()[0]);
    expect(await stampOf(B)).toBe(readyChecks()[0]);
  });

  it("touches a stranded lobby only once it has seen it a minute apart", async () => {
    await strandedByDeadPass();
    await redis.del(regionLock, lobbyLock(A), lobbyLock(B));
    const before = published.length;
    const playCounts = broadcasts.length;

    await sweep();
    await sweep();

    expect(await queued()).toEqual([]);
    expect(published.slice(before)).toEqual([]);
    expect(broadcasts).toHaveLength(playCounts);

    await aMinuteLater();
    await sweep();

    expect(await queued()).toEqual([A, B]);
  });

  it("starts over when the lobby was not stranded in between", async () => {
    await strandedByDeadPass();
    await redis.del(regionLock, lobbyLock(A), lobbyLock(B));

    await sweep();

    // a pass is running in the region the next time round
    await redis.set(regionLock, 1);
    await aMinuteLater();
    await sweep();
    await redis.del(regionLock);

    await aMinuteLater();
    await sweep();
    expect(await queued()).toEqual([]);

    await aMinuteLater();
    await sweep();
    expect(await queued()).toEqual([A, B]);
  });

  it("starts over when the lobby was in a ready check in between", async () => {
    const frozen = await strandedByDeadPass();
    await redis.del(regionLock, lobbyLock(A), lobbyLock(B));

    await sweep();

    // the pass was slow, not dead: its ready check starts after all
    frozen.mockRestore();
    await (matchmake as any).createMatchConfirmation(REGION, "Duel", {
      team1: { lobbies: [A], players: [{ steam_id: A, rank: 5000 }] },
      team2: { lobbies: [B], players: [{ steam_id: B, rank: 5000 }] },
    });
    const [confirmationId] = readyChecks();
    await aMinuteLater();
    await sweep();

    // only A accepts, so the cancel puts A back, and the next pass to claim it
    // does die
    await confirm(confirmationId, A);
    await matchmake.cancelMatchMaking(confirmationId);
    expect(await queued()).toEqual([A]);
    await (matchmake as any).claimLobby(A);
    await redis.del(lobbyLock(A));

    await aMinuteLater();
    await sweep();
    expect(await queued()).toEqual([]);

    await aMinuteLater();
    await sweep();
    expect(await queued()).toEqual([A]);
  });

  it("never puts back a lobby whose leave is stuck sending the Play count", async () => {
    await join(A);

    const stuck = new Promise<void>((reached) => {
      onRegionStats = () => {
        onRegionStats = async () => {};
        reached();
        return new Promise<void>(() => {});
      };
    });
    void gateway.leaveQueue(clientOf(A));
    await stuck;

    for (let minute = 0; minute < 5; minute++) {
      await sweep();
      await aMinuteLater();
    }

    expect(await detailsOf(A)).toBeNull();
    expect(await queued()).toEqual([]);
    expect(await ranked()).toEqual([]);
    expect(sentTo(A, "matchmaking:details").at(-1).data).toEqual({});
  });

  it("keeps a lobby that queued again while its leave was still sending the Play count", async () => {
    await join(A);

    let finishLeave: () => void;
    const midLeave = new Promise<void>((reached) => {
      onRegionStats = () => {
        onRegionStats = async () => {};
        reached();
        return new Promise<void>((finish) => {
          finishLeave = finish;
        });
      };
    });
    const leaving = gateway.leaveQueue(clientOf(A));
    await midLeave;

    await join(A);
    finishLeave();
    await leaving;

    expect(errorCodes(A)).toEqual([]);
    expect(await detailsOf(A)).not.toBeNull();
    expect(await queued()).toEqual([A]);
    expect(await ranked()).toEqual([A]);
  });

  it("clears the stamp of a lobby with no details when it leaves", async () => {
    await redis.hset(
      getMatchmakingLobbyDetailsCacheKey(A),
      "confirmationId",
      "some-confirmation",
    );

    await gateway.leaveQueue(clientOf(A));

    expect(await redis.exists(getMatchmakingLobbyDetailsCacheKey(A))).toBe(0);
  });

  it("drops a ready check's lobbies when its cancel ran after it expired", async () => {
    await join(A);
    await join(B);
    await runPass();
    const [confirmationId] = readyChecks();

    await expireReadyCheck(confirmationId);
    await matchmake.cancelMatchMaking(confirmationId);

    // stuck: the lobby is told it is already queued until it clicks Leave
    await join(A);
    expect(errorCodes(A)).toEqual(["already_queued"]);

    await sweepTwice();

    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).toBeNull();
      expect(await stampOf(lobbyId)).toBeNull();
      expect(sentTo(lobbyId, "matchmaking:details").at(-1).data).toEqual({});
    }
    expect(await queued()).toEqual([]);

    await join(A);

    expect(errorCodes(A)).toEqual(["already_queued"]);
    expect(await queued()).toEqual([A]);
  });

  // The pod died while it was creating the match, and the cancel job leaves a
  // ready check to the creation that has it.
  it("drops the lobbies of a ready check whose creation died, once its retries would be over", async () => {
    await join(A);
    await join(B);
    await runPass();
    const [confirmationId] = readyChecks();
    const key = getMatchmakingConformationCacheKey(confirmationId);

    const died = new Promise<void>((reached) => {
      createMatch.mockImplementationOnce(() => {
        reached();
        return new Promise(() => {});
      });
    });
    await confirm(confirmationId, A);
    void confirm(confirmationId, B);
    await died;

    await matchmake.cancelMatchMaking(confirmationId);

    // a cancel job could still be retrying
    await readyCheckExpired(confirmationId, 60);
    await sweepTwice();

    for (const lobbyId of [A, B]) {
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }

    await readyCheckExpired(confirmationId, 5 * 60);
    expect(await redis.exists(`${key}:creating`)).toBe(1);
    await sweepTwice();

    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).toBeNull();
      expect(await stampOf(lobbyId)).toBeNull();
      expect(sentTo(lobbyId, "matchmaking:details").at(-1).data).toEqual({});
    }
    expect(await queued()).toEqual([]);
    expect(await redis.exists(key, `${key}:confirmed`, `${key}:creating`)).toBe(
      0,
    );

    // nobody can accept it into a match now
    await confirm(confirmationId, A);
    await confirm(confirmationId, B);
    expect(createMatch).toHaveBeenCalledTimes(1);

    await join(A);
    expect(errorCodes(A)).toEqual([]);
    expect(await queued()).toEqual([A]);
  });

  it("puts every lobby back when its match cannot be created", async () => {
    await join(A);
    await join(B);
    await runPass();
    const [confirmationId] = readyChecks();
    const key = getMatchmakingConformationCacheKey(confirmationId);

    createMatch.mockRejectedValueOnce(new Error("hasura unavailable"));
    await confirm(confirmationId, A);
    await expect(confirm(confirmationId, B)).rejects.toThrow(
      "hasura unavailable",
    );

    expect(await queued()).toEqual([A, B]);
    expect(await ranked()).toEqual([A, B]);
    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).not.toBeNull();
      expect(await stampOf(lobbyId)).toBeNull();
      expect(await redis.exists(lobbyLock(lobbyId))).toBe(0);
    }
    expect(await redis.exists(key, `${key}:confirmed`, `${key}:creating`)).toBe(
      0,
    );

    // the cancel job, 30s later, has nothing left to do
    await matchmake.cancelMatchMaking(confirmationId);
    expect(await queued()).toEqual([A, B]);
  });

  it("leaves a ready check to its creation when the cancel job fires during it", async () => {
    await join(A);
    await join(B);
    await runPass();
    const [confirmationId] = readyChecks();
    const key = getMatchmakingConformationCacheKey(confirmationId);

    let finishCreating: () => void;
    const creating = new Promise<void>((reached) => {
      createMatch.mockImplementationOnce(() => {
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
    await confirm(confirmationId, A);
    const accepted = confirm(confirmationId, B);
    await creating;

    await matchmake.cancelMatchMaking(confirmationId);

    expect(await queued()).toEqual([]);
    for (const lobbyId of [A, B]) {
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }
    expect(await redis.hget(key, "lobbyIds")).not.toBeNull();

    finishCreating();
    await accepted;

    expect(await redis.hget(key, "matchId")).toBe("match-1");
    expect(await queued()).toEqual([]);
    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).not.toBeNull();
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }
  });

  // The hash outlives the ready check, so one that nothing cancelled can
  // still be accepted minutes later.
  it("leaves a ready check alone while a late accept is creating its match", async () => {
    await join(A);
    await join(B);
    await runPass();
    const [confirmationId] = readyChecks();
    const key = getMatchmakingConformationCacheKey(confirmationId);

    await readyCheckExpired(confirmationId, 5 * 60);
    await sweep();

    let finishCreating: () => void;
    const creating = new Promise<void>((reached) => {
      createMatch.mockImplementationOnce(() => {
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
    await confirm(confirmationId, A);
    const accepted = confirm(confirmationId, B);
    await creating;

    await aMinuteLater();
    await sweep();

    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).not.toBeNull();
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }
    expect(await redis.hget(key, "lobbyIds")).not.toBeNull();

    finishCreating();
    await accepted;
    await sweepTwice();

    expect(await redis.hget(key, "matchId")).toBe("match-1");
    for (const lobbyId of [A, B]) {
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }
  });

  it("leaves a ready check alone when its match appears as the sweep decides", async () => {
    await join(A);
    await join(B);
    await runPass();
    const [confirmationId] = readyChecks();
    const key = getMatchmakingConformationCacheKey(confirmationId);

    await readyCheckExpired(confirmationId, 5 * 60);
    await sweep();
    await aMinuteLater();

    const hmget = redis.hmget.bind(redis) as (...args: any[]) => Promise<any>;
    jest.spyOn(redis, "hmget").mockImplementation((async (...args: any[]) => {
      const read = await hmget(...args);
      await redis.hset(key, "matchId", "match-1");
      return read;
    }) as any);

    await sweep();

    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).not.toBeNull();
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }
    expect(await redis.hget(key, "lobbyIds")).not.toBeNull();
  });

  it("never requeues a lobby whose player went into another match", async () => {
    await strandedByDeadPass();
    await redis.del(regionLock, lobbyLock(A), lobbyLock(B));
    busy.add(A);

    await sweepTwice();

    expect(await queued()).toEqual([B]);
    expect(await detailsOf(A)).toBeNull();
    expect(errorCodes(A)).toEqual(["player_in_match"]);
    expect(sentTo(A, "matchmaking:details").at(-1).data).toEqual({});
  });

  it("drops a stranded lobby whose player has since joined a party", async () => {
    await strandedByDeadPass();
    await redis.del(regionLock, lobbyLock(A), lobbyLock(B));

    partyOf.set(A, PARTY);
    partyOf.set("76561198000000003", PARTY);

    await sweepTwice();

    expect(await detailsOf(A)).toBeNull();
    expect(await queued()).toEqual([B]);
  });

  it("leaves a lobby in a live ready check, and the match it made, alone", async () => {
    await join(A);
    await join(B);
    await runPass();
    const [confirmationId] = readyChecks();

    // the ready check outlives the lobby locks it took
    await redis.del(lobbyLock(A), lobbyLock(B));
    const before = published.length;

    await sweepTwice();

    expect(await queued()).toEqual([]);
    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).not.toBeNull();
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }
    expect(published.slice(before)).toEqual([]);

    await confirm(confirmationId, A);
    await confirm(confirmationId, B);
    expect(
      await redis.hget(
        getMatchmakingConformationCacheKey(confirmationId),
        "matchId",
      ),
    ).toBe("match-1");

    // the match outlives its ready check by hours
    await readyCheckExpired(confirmationId, 3 * 60 * 60);
    await sweepTwice();

    expect(await queued()).toEqual([]);
    for (const lobbyId of [A, B]) {
      expect(await detailsOf(lobbyId)).not.toBeNull();
      expect(await stampOf(lobbyId)).toBe(confirmationId);
    }
  });

  it("leaves a lobby alone while a pass still holds it", async () => {
    await strandedByDeadPass();
    const before = published.length;

    await sweepTwice();
    expect(await queued()).toEqual([]);

    // the lobby lock runs out first, the pass still holds the region
    await redis.del(lobbyLock(A), lobbyLock(B));
    await sweepTwice();
    expect(await queued()).toEqual([]);

    expect(await detailsOf(A)).not.toBeNull();
    expect(published.slice(before)).toEqual([]);

    await redis.del(regionLock);
    await sweepTwice();
    expect(await queued()).toEqual([A, B]);
  });

  it("leaves a lobby that queued again while the sweep checked it alone", async () => {
    await strandedByDeadPass();
    await redis.del(regionLock, lobbyLock(A), lobbyLock(B));

    onBusyCheck = async (steamIds) => {
      if (steamIds.includes(A)) {
        onBusyCheck = async () => {};
        await gateway.leaveQueue(clientOf(A));
        await join(A, "Wingman");
      }
    };

    await sweepTwice();

    expect(await queued()).toEqual([B]);
    expect(await ranked()).toEqual([B]);
    expect(
      await redis.zrange(getMatchmakingQueueCacheKey("Wingman", REGION), 0, -1),
    ).toEqual([A]);
    expect(JSON.parse(await detailsOf(A)).type).toBe("Wingman");
  });

  it("clears a stamp left on a lobby that is gone", async () => {
    await redis.hset(
      getMatchmakingLobbyDetailsCacheKey(A),
      "confirmationId",
      "expired-confirmation",
    );

    await sweepTwice();

    expect(await redis.exists(getMatchmakingLobbyDetailsCacheKey(A))).toBe(0);
  });

  describe("queue entries that are not the lobby's", () => {
    // The Play count only tidies the regions it reports on, which leaves out
    // LAN regions and regions with no servers.
    it("drops an entry with no lobby behind it when a pass reaches it", async () => {
      await strayEntry(A, "Duel", "lan");
      await redis.hset(
        getMatchmakingLobbyDetailsCacheKey(A),
        "confirmationId",
        "expired-confirmation",
      );

      await runPass("Duel", "lan");

      expect(await queued("Duel", "lan")).toEqual([]);
      expect(await ranked("Duel", "lan")).toEqual([]);
      expect(readyChecks()).toEqual([]);
    });

    it("keeps an entry whose lobby queued for real after the pass found it stray", async () => {
      await strayEntry(A, "Duel");

      const read = lobbies.getLobbyDetails.bind(lobbies);
      let joins = true;
      jest
        .spyOn(lobbies, "getLobbyDetails")
        .mockImplementation(async (lobbyId: string) => {
          const details = await read(lobbyId);
          if (lobbyId === A && joins) {
            joins = false;
            await join(A);
          }
          return details;
        });

      await runPass();

      expect(await queued()).toEqual([A]);
      expect(await ranked()).toEqual([A]);
    });

    it("has the Play count drop the entries a lobby's details do not name", async () => {
      statsRegions = [REGION, "eu-west"];
      await strayEntry(A, "Duel", REGION);
      await strayEntry(A, "Duel", "eu-west");

      // A queues for one of the two regions as the Play count reads it
      const read = lobbies.getLobbyDetails.bind(lobbies);
      let joins = true;
      jest
        .spyOn(lobbies, "getLobbyDetails")
        .mockImplementation(async (lobbyId: string) => {
          const details = await read(lobbyId);
          if (lobbyId === A && joins) {
            joins = false;
            await join(A);
          }
          return details;
        });

      await matchmake.sendRegionStats();

      expect(await queued("Duel", REGION)).toEqual([A]);
      expect(await ranked("Duel", REGION)).toEqual([A]);
      expect(await queued("Duel", "eu-west")).toEqual([]);
      expect(await ranked("Duel", "eu-west")).toEqual([]);
    });

    it("matches a lobby only for the type it is queued for now", async () => {
      const others = Array.from(
        { length: 12 },
        (_, index) => `765611980000001${10 + index}`,
      );

      await join(A, "Wingman");
      await strayEntry(A, "Competitive");
      for (const steamId of others.slice(0, 9)) {
        await join(steamId, "Competitive");
      }

      await runPass("Competitive");

      expect(readyChecks()).toEqual([]);
      expect(await stampOf(A)).toBeNull();
      expect(await queued("Competitive")).not.toContain(A);
      expect(await ranked("Competitive")).not.toContain(A);
      expect(await queued("Wingman")).toEqual([A]);

      for (const steamId of others.slice(9)) {
        await join(steamId, "Wingman");
      }
      await runPass("Wingman");

      expect(readyChecks()).toHaveLength(1);
      const { type, team1, team2 } =
        await matchmake.getMatchConfirmationDetails(readyChecks()[0]);
      expect(type).toBe("Wingman");
      expect([...team1, ...team2].map((player) => player.steam_id)).toContain(
        A,
      );
    });

    it("does not claim a lobby that queued for another type after the pass read it", async () => {
      await join(A);
      await join(B);

      const read = lobbies.getLobbyDetails.bind(lobbies);
      let movesOn = true;
      jest
        .spyOn(lobbies, "getLobbyDetails")
        .mockImplementation(async (lobbyId: string) => {
          const details = await read(lobbyId);
          if (lobbyId === A && movesOn) {
            movesOn = false;
            await gateway.leaveQueue(clientOf(A));
            await join(A, "Wingman");
            await strayEntry(A, "Duel");
          }
          return details;
        });

      await runPass();

      expect(readyChecks()).toEqual([]);
      expect(await stampOf(A)).toBeNull();
      expect(await queued("Wingman")).toEqual([A]);

      await runPass();

      expect(await queued()).toEqual([B]);
      expect(await ranked()).toEqual([B]);
      expect(await queued("Wingman")).toEqual([A]);
    });
  });

  it("ignores a lobby that is gone by the time it is read", async () => {
    const scan = jest
      .spyOn(redis, "scan")
      .mockResolvedValue(["0", [getMatchmakingLobbyDetailsCacheKey(A)]] as any);

    await sweepTwice();
    scan.mockRestore();

    expect(broadcasts).toEqual([]);
    expect(await redis.keys("*")).toEqual([]);
  });
});
