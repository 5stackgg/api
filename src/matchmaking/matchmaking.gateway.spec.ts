import { Logger } from "@nestjs/common";
import { e_match_types_enum } from "generated";

jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { MatchmakingGateway } from "./matchmaking.gateway";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { FakeRedis } from "./testing/fakeRedis";
import { CacheService } from "../cache/cache.service";
import {
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";

const CAPTAIN = {
  steam_id: "76561198000000001",
  name: "Captain",
  role: "user",
};
const OTHER = {
  steam_id: "76561198000000002",
  name: "Other",
  role: "user",
};
const PLAYERS = [CAPTAIN, OTHER];
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
  let lobbies: MatchmakingLobbyService;
  let queue: { add: jest.Mock; remove: jest.Mock };
  let settings: Array<{ name: string; value: string }>;

  const clientOf = (player: typeof CAPTAIN) =>
    ({
      user: player,
      sessionId: `session-${player.steam_id}`,
      authentication: Promise.resolve(),
    }) as any;

  const client = clientOf(CAPTAIN);

  beforeEach(() => {
    redis = new FakeRedis();
    settings = [];

    const hasura = {
      query: jest.fn(async (payload: Record<string, any>) => {
        if (payload.settings) {
          return { settings };
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
          const player = PLAYERS.find(
            ({ steam_id }) =>
              steam_id === payload.players_by_pk.__args.steam_id,
          );
          return {
            players_by_pk: {
              name: player.name,
              steam_id: player.steam_id,
              is_banned: false,
              matchmaking_cooldown: null,
              current_lobby_id: null,
              is_in_another_match: false,
            },
          };
        }
        if (payload.players?.__args.where.is_in_another_match) {
          return { players: [] };
        }
        if (payload.players) {
          return {
            players: payload.players.__args.where.steam_id._in.map(
              (steam_id: string) => ({ steam_id, elo: {} }),
            ),
          };
        }
        throw new Error(`unexpected query ${Object.keys(payload)}`);
      }),
      mutation: jest.fn(),
    };

    const redisManager = { getConnection: () => redis };
    const logger = new Logger("Test");

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
      {} as any,
      lobbies,
      {
        notifyMatchFound: jest.fn().mockResolvedValue(0),
        retractMatchFound: jest.fn().mockResolvedValue(undefined),
      } as any,
      queue as any,
    );
    (lobbies as any).matchmaking = matchmake;

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

  const join = (type: e_match_types_enum, who = client) =>
    gateway.joinQueue({ type, regions: ["us-east"] }, who);

  function queueEntries(lobbyId = LOBBY_ID) {
    const entries: string[] = [];
    for (const type of TYPES) {
      for (const region of REGIONS) {
        if (
          redis
            .members(getMatchmakingQueueCacheKey(type, region))
            .includes(lobbyId)
        ) {
          entries.push(`${type}/${region}`);
        }
        if (
          redis
            .members(getMatchmakingRankCacheKey(type, region))
            .includes(lobbyId)
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

  const messages = (event: string) =>
    redis.published
      .filter((entry) => entry.channel === "send-message-to-steam-id")
      .map((entry) => JSON.parse(entry.message))
      .filter((message) => message.event === event);

  const errors = () => messages("matchmaking:error");

  const readyChecks = () =>
    queue.add.mock.calls.filter(([name]) => name === "CancelMatchMaking");

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
    await redis.hset(getMatchmakingConformationCacheKey("confirmation-1"), {
      lobbyIds: JSON.stringify([LOBBY_ID]),
    });
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

  // The pass has read the captain's details when the captain leaves.
  async function passWhileCaptainLeaves() {
    await join("Duel", clientOf(OTHER));
    await join("Duel");

    const read = lobbies.getLobbyDetails.bind(lobbies);
    let leaveDuringPass = true;
    jest
      .spyOn(lobbies, "getLobbyDetails")
      .mockImplementation(async (lobbyId: string) => {
        const details = await read(lobbyId);
        if (lobbyId === LOBBY_ID && leaveDuringPass) {
          leaveDuringPass = false;
          await gateway.leaveQueue(client);
        }
        return details;
      });

    await MatchmakeService.prototype.matchmake.call(
      matchmake,
      "Duel",
      "us-east",
    );
  }

  it("does not put a lobby that left while a pass read it into a ready check", async () => {
    await passWhileCaptainLeaves();

    expect(readyChecks()).toEqual([]);
    expect(
      await redis.hget(
        getMatchmakingLobbyDetailsCacheKey(LOBBY_ID),
        "confirmationId",
      ),
    ).toBeNull();
    expect(queueEntries(OTHER.steam_id)).toEqual([
      "Duel/us-east",
      "Duel/us-east/ranks",
    ]);
  });

  it("lets a lobby that left while a pass read it queue again", async () => {
    await passWhileCaptainLeaves();

    // whatever ready check the pass started runs out
    for (const [, { confirmationId }] of readyChecks()) {
      await matchmake.cancelMatchMaking(confirmationId);
    }

    await join("Duel");

    expect(errors()).toEqual([]);
    expect(queueEntries()).toEqual(["Duel/us-east", "Duel/us-east/ranks"]);
  });

  it("lets a lobby queue again when its stamp names a ready check that is over", async () => {
    await redis.hset(
      getMatchmakingLobbyDetailsCacheKey(LOBBY_ID),
      "confirmationId",
      "finished-confirmation",
    );

    await join("Competitive");

    expect(errors()).toEqual([]);
    expect(queueEntries()).toEqual([
      "Competitive/us-east",
      "Competitive/us-east/ranks",
    ]);
    // a fresh queue entry shows no ready check
    expect(
      messages("matchmaking:details").at(-1).data.confirmation,
    ).toBeFalsy();
  });

  it.each([
    ["public.matchmaking", "false", "matchmaking_disabled"],
    ["public.matchmaking_competitive", "false", "queue_disabled"],
    ["public.matchmaking_min_role", "administrator", "role_required"],
  ])(
    "tells the player why they cannot queue when %s is %s",
    async (name, value, code) => {
      settings = [{ name, value }];

      await join("Competitive");

      expect(queueEntries()).toEqual([]);
      expect(errors()).toEqual([
        {
          steamId: CAPTAIN.steam_id,
          event: "matchmaking:error",
          data: expect.objectContaining({ code }),
        },
      ]);
    },
  );

  // A second tab, or a double click, can hold the join lock for longer than
  // the second join waits on it.
  it("leaves a queued lobby alone when another join holds its lock", async () => {
    await join("Competitive");
    const details = await redis.hget(
      getMatchmakingLobbyDetailsCacheKey(LOBBY_ID),
      "details",
    );

    await redis.set(`lock:matchmaking:verify:${LOBBY_ID}`, 1, "EX", 60, "NX");
    await join("Competitive");

    expect(queueEntries()).toEqual([
      "Competitive/us-east",
      "Competitive/us-east/ranks",
    ]);
    expect(
      await redis.hget(getMatchmakingLobbyDetailsCacheKey(LOBBY_ID), "details"),
    ).toBe(details);
    expect(errors()).toEqual([
      {
        steamId: CAPTAIN.steam_id,
        event: "matchmaking:error",
        data: expect.objectContaining({ code: "queue_busy" }),
      },
    ]);
  });

  it("clears a lobby's stamp when it leaves, even with no details left", async () => {
    await redis.hset(
      getMatchmakingLobbyDetailsCacheKey(LOBBY_ID),
      "confirmationId",
      "orphaned-confirmation",
    );

    await gateway.leaveQueue(client);

    expect(
      await redis.hget(
        getMatchmakingLobbyDetailsCacheKey(LOBBY_ID),
        "confirmationId",
      ),
    ).toBeNull();
  });
});
