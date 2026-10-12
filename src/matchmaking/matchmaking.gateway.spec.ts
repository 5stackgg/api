import { Logger } from "@nestjs/common";
import { e_match_types_enum } from "generated";

jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { MatchmakingGateway } from "./matchmaking.gateway";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { FakeRedis } from "./testing/fakeRedis";
import {
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";

const CAPTAIN = {
  steam_id: "76561198000000001",
  name: "Captain",
  role: "user",
};
const LOBBY_ID = CAPTAIN.steam_id;
const REGIONS = ["us-east", "eu-west"];
const TYPES: e_match_types_enum[] = ["Duel", "Wingman", "Rush", "Competitive"];

/**
 * joinQueue against the real lobby and matchmake services on an in-memory
 * redis, so the assertions are about what ends up in the queue.
 */
describe("MatchmakingGateway.joinQueue", () => {
  let redis: FakeRedis;
  let gateway: MatchmakingGateway;
  let matchmake: MatchmakeService;

  const client = {
    user: CAPTAIN,
    sessionId: "session-1",
    authentication: Promise.resolve(),
  } as any;

  beforeEach(() => {
    redis = new FakeRedis();

    const hasura = {
      query: jest.fn(async (payload: Record<string, any>) => {
        if (payload.settings) {
          return { settings: [] };
        }
        if (payload.server_regions) {
          return {
            server_regions: REGIONS.map((value) => ({
              value,
              is_lan: false,
              status: "Online",
            })),
          };
        }
        if (payload.game_server_nodes_aggregate) {
          return { game_server_nodes_aggregate: { aggregate: { count: 0 } } };
        }
        if (payload.players_by_pk) {
          return {
            players_by_pk: {
              name: CAPTAIN.name,
              steam_id: CAPTAIN.steam_id,
              is_banned: false,
              matchmaking_cooldown: null,
              current_lobby_id: null,
              is_in_another_match: false,
            },
          };
        }
        if (payload.players) {
          return { players: [{ steam_id: CAPTAIN.steam_id, elo: {} }] };
        }
        throw new Error(`unexpected query ${Object.keys(payload)}`);
      }),
      mutation: jest.fn(),
    };

    const redisManager = { getConnection: () => redis };
    const logger = new Logger("Test");

    const lobbies = new MatchmakingLobbyService(
      logger,
      hasura as any,
      redisManager as any,
      undefined,
    );
    matchmake = new MatchmakeService(
      logger,
      hasura as any,
      redisManager as any,
      {} as any,
      lobbies,
      { notifyMatchFound: jest.fn(), retractMatchFound: jest.fn() } as any,
      { add: jest.fn(), remove: jest.fn() } as any,
    );
    (lobbies as any).matchmaking = matchmake;

    jest.spyOn(matchmake, "matchmake").mockResolvedValue(undefined);

    gateway = new MatchmakingGateway(
      logger,
      hasura as any,
      redisManager as any,
      matchmake,
      lobbies,
      {
        lock: async (_key: string, callback: () => Promise<unknown>) =>
          callback(),
      } as any,
    );
  });

  const join = (type: e_match_types_enum) =>
    gateway.joinQueue({ type, regions: ["us-east"] }, client);

  function queueEntries() {
    const entries: string[] = [];
    for (const type of TYPES) {
      for (const region of REGIONS) {
        if (
          redis
            .members(getMatchmakingQueueCacheKey(type, region))
            .includes(LOBBY_ID)
        ) {
          entries.push(`${type}/${region}`);
        }
        if (
          redis
            .members(getMatchmakingRankCacheKey(type, region))
            .includes(LOBBY_ID)
        ) {
          entries.push(`${type}/${region}/ranks`);
        }
      }
    }
    return entries;
  }

  const queuedType = async () =>
    JSON.parse(
      await redis.hget(getMatchmakingLobbyDetailsCacheKey(LOBBY_ID), "details"),
    ).type;

  const errors = () =>
    redis.published
      .filter((entry) => entry.channel === "send-message-to-steam-id")
      .map((entry) => JSON.parse(entry.message))
      .filter((message) => message.event === "matchmaking:error");

  it("queues a lobby that is not queued yet", async () => {
    await join("Competitive");

    expect(queueEntries()).toEqual([
      "Competitive/us-east",
      "Competitive/us-east/ranks",
    ]);
    expect(errors()).toEqual([]);
    expect(matchmake.matchmake).toHaveBeenCalledWith("Competitive", "us-east");
  });

  it("refuses a lobby that is in a ready check", async () => {
    await join("Competitive");

    // what a pass does when it claims the lobby into a ready check
    for (const type of TYPES) {
      await redis.zrem(getMatchmakingQueueCacheKey(type, "us-east"), LOBBY_ID);
      await redis.zrem(getMatchmakingRankCacheKey(type, "us-east"), LOBBY_ID);
    }
    await redis.hset(
      getMatchmakingLobbyDetailsCacheKey(LOBBY_ID),
      "confirmationId",
      "confirmation-1",
    );
    const details = await redis.hget(
      getMatchmakingLobbyDetailsCacheKey(LOBBY_ID),
      "details",
    );
    (matchmake.matchmake as jest.Mock).mockClear();

    // a second tab, or another device, joins while the ready check is up
    await join("Competitive");

    expect(queueEntries()).toEqual([]);
    expect(
      await redis.hget(getMatchmakingLobbyDetailsCacheKey(LOBBY_ID), "details"),
    ).toBe(details);
    expect(matchmake.matchmake).not.toHaveBeenCalled();
    expect(errors()).toEqual([
      {
        steamId: CAPTAIN.steam_id,
        event: "matchmaking:error",
        data: expect.objectContaining({ code: "already_queued" }),
      },
    ]);
  });

  it("leaves no stale entries when a queued lobby asks for another type", async () => {
    await join("Competitive");
    await join("Wingman");

    const type = await queuedType();
    expect(queueEntries()).toEqual([
      `${type}/us-east`,
      `${type}/us-east/ranks`,
    ]);

    await gateway.leaveQueue(client);

    expect(queueEntries()).toEqual([]);
  });
});
