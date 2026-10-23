import { PresenceService } from "./presence.service";

// Enough of redis for presence: strings, sets, sorted sets, hashes, MULTI and
// pipelines, with every publish kept for the tests to read.
class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  zsets = new Map<string, Map<string, number>>();
  hashes = new Map<string, Record<string, string>>();
  published: Array<{ channel: string; message: any }> = [];

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.strings.set(key, value);
    return "OK";
  }
  async mget(keys: string[]) {
    return keys.map((key) => this.strings.get(key) ?? null);
  }
  async exists(key: string) {
    return this.strings.has(key) ? 1 : 0;
  }
  async hgetall(key: string) {
    return this.hashes.get(key) ?? {};
  }
  private setOf(key: string) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key)!;
  }
  async sadd(key: string, member: string) {
    const set = this.setOf(key);
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    return added;
  }
  async srem(key: string, member: string) {
    return this.setOf(key).delete(member) ? 1 : 0;
  }
  async scard(key: string) {
    return this.setOf(key).size;
  }
  async smembers(key: string) {
    return [...this.setOf(key)];
  }
  private zsetOf(key: string) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    return this.zsets.get(key)!;
  }
  async zadd(key: string, score: number, member: string) {
    const zset = this.zsetOf(key);
    const added = zset.has(member) ? 0 : 1;
    zset.set(member, score);
    return added;
  }
  async zrem(key: string, member: string) {
    return this.zsetOf(key).delete(member) ? 1 : 0;
  }
  async zcard(key: string) {
    return this.zsetOf(key).size;
  }
  async zmscore(key: string, ...members: string[]) {
    const zset = this.zsetOf(key);
    return members.map((member) =>
      zset.has(member) ? String(zset.get(member)) : null,
    );
  }
  async zrange(key: string) {
    return [...this.zsetOf(key).entries()]
      .sort(([, a], [, b]) => a - b)
      .map(([member]) => member);
  }
  async publish(channel: string, message: string) {
    this.published.push({ channel, message: JSON.parse(message) });
    return 1;
  }
  private batch() {
    const queued: Array<() => Promise<unknown>> = [];
    const chain: any = {
      exec: async () => {
        const results = [];
        for (const run of queued) results.push([null, await run()]);
        return results;
      },
    };
    for (const command of ["sadd", "srem", "scard", "exists"]) {
      chain[command] = (...args: any[]) => {
        queued.push(() => (this as any)[command](...args));
        return chain;
      };
    }
    return chain;
  }
  multi() {
    return this.batch();
  }
  pipeline() {
    return this.batch();
  }
}

const A = "76561198000000001";
const B = "76561198000000002";
const C = "76561198000000003";
const D = "76561198000000004";

function makePresence(
  circles: Record<string, { friends: string[][]; team: string[] }> = {},
) {
  const redis = new FakeRedis();
  const hasura = {
    query: jest.fn(async (request: any) => {
      if (request.players) {
        return {
          players: request.players.__args.where.steam_id._in.map(
            (steam_id: string) => ({ steam_id, name: `player ${steam_id}` }),
          ),
        };
      }
      const steamId = request.friends.__args.where._or[0].player_steam_id._eq;
      const circle = circles[steamId] ?? { friends: [], team: [] };
      return {
        friends: circle.friends.map(([player, other]) => ({
          player_steam_id: player,
          other_player_steam_id: other,
        })),
        team_roster: circle.team.map((player_steam_id) => ({
          player_steam_id,
        })),
      };
    }),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const presence = new PresenceService(
    logger as any,
    { getConnection: () => redis } as any,
    hasura as any,
  );
  return { presence, redis, hasura };
}

const tab = (steamId: string, id: string, sessionId = `session-${id}`) =>
  ({
    id,
    node: "pod-1",
    sessionId,
    user: { steam_id: steamId },
    readyState: 1,
    OPEN: 1,
    send: jest.fn(),
  }) as any;

const sent = (client: any) =>
  client.send.mock.calls.map(([message]: [string]) => JSON.parse(message));

const online = (redis: FakeRedis, ...steamIds: string[]) => {
  for (const steamId of steamIds) {
    redis.zsets.set(
      PresenceService.ONLINE,
      new Map([
        ...(redis.zsets.get(PresenceService.ONLINE) ?? new Map()),
        [steamId, 1],
      ]),
    );
    redis.strings.set(`players:${steamId}`, "{}");
  }
};

const lanProbe = (
  redis: FakeRedis,
  sessionId: string,
  results: Array<{ region: string; latency: number; isLan: boolean }>,
) => {
  redis.hashes.set(
    `latency-test:${sessionId}`,
    Object.fromEntries(
      results.map((result) => [result.region, JSON.stringify(result)]),
    ),
  );
};

const toSteamIds = (redis: FakeRedis) =>
  redis.published
    .filter(({ channel }) => channel === "send-message-to-steam-id")
    .map(({ message }) => [message.steamId, message.data.online]);

const lanEvents = (redis: FakeRedis) =>
  redis.published
    .filter(({ channel }) => channel === "lan-message")
    .map(({ message }) => message.data);

describe("PresenceService", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("the online count", () => {
    it("goes out at once for the first change and once more after a burst", async () => {
      jest.useFakeTimers();
      const { presence, redis } = makePresence();
      const counts = () =>
        redis.published
          .filter(({ message }) => message.event === "players-online:count")
          .map(({ message }) => message.data);

      await presence.cameOnline(A);
      await jest.advanceTimersByTimeAsync(0);
      await presence.cameOnline(B);
      await presence.cameOnline(C);
      expect(counts()).toEqual([1]);

      await jest.advanceTimersByTimeAsync(PresenceService.COUNT_INTERVAL_MS);
      expect(counts()).toEqual([1, 3]);

      await jest.advanceTimersByTimeAsync(
        PresenceService.COUNT_INTERVAL_MS * 3,
      );
      expect(counts()).toEqual([1, 3]);
      presence.onApplicationShutdown();
    });
  });

  describe("a player's circle", () => {
    const circles = {
      [A]: {
        friends: [
          [A, B],
          [D, A],
        ],
        team: [A, C],
      },
    };

    it("hears when they come and go, but only the members who are online", async () => {
      const { presence, redis } = makePresence(circles);
      online(redis, B, C);

      await presence.cameOnline(A);
      await presence.cameOnline(A);
      await presence.wentOffline(A);
      await presence.wentOffline(A);
      presence.onApplicationShutdown();

      expect(toSteamIds(redis)).toEqual([
        [B, true],
        [C, true],
        [B, false],
        [C, false],
      ]);
    });

    it("is what a connecting tab gets, with the count", async () => {
      const { presence, redis } = makePresence(circles);
      online(redis, A, B, D);
      const client = tab(A, "client-1");

      await presence.welcome(client);

      expect(sent(client)).toEqual([
        { event: "players-online:count", data: 3 },
        { event: "friends-online", data: [B, D] },
      ]);
    });

    it("is looked up afresh when a tab asks again", async () => {
      const { presence, redis, hasura } = makePresence(circles);
      online(redis, B, C);
      const client = tab(A, "client-1");
      await presence.welcome(client);
      circles[A].team.push(D);
      online(redis, D);

      await presence.sendFriendsOnline(client);

      expect(hasura.query).toHaveBeenCalledTimes(2);
      expect(sent(client).at(-1)).toEqual({
        event: "friends-online",
        data: [B, C, D],
      });
      circles[A].team.pop();
    });
  });

  it("says which of up to 50 players are online", async () => {
    const { presence, redis } = makePresence();
    const asked = [
      B,
      C,
      ...Array.from({ length: 60 }, (_, index) => String(index)),
    ];
    online(redis, B, "9", "55");
    const client = tab(A, "client-1");

    await presence.check(client, { requestId: "r-1", steamIds: asked });
    await presence.check(client, { requestId: "r-2", steamIds: "nope" });

    expect(sent(client)).toEqual([
      {
        event: "players-online:check",
        data: { requestId: "r-1", online: [B, "9"] },
      },
    ]);
  });

  describe("LANs", () => {
    it("puts a tab on the closest LAN its probe found and sends it that LAN's players", async () => {
      const { presence, redis } = makePresence();
      const other = tab(B, "client-2");
      lanProbe(redis, other.sessionId, [
        { region: "Vulkan LAN", latency: 3, isLan: true },
      ]);
      await presence.syncLan(other);
      const client = tab(A, "client-1");
      lanProbe(redis, client.sessionId, [
        { region: "Haag LAN", latency: 9, isLan: true },
        { region: "Vulkan LAN", latency: 2, isLan: true },
        { region: "Europe", latency: 1, isLan: false },
      ]);

      await presence.syncLan(client);

      expect(client.lanRegion).toBe("Vulkan LAN");
      expect(sent(client)).toEqual([
        {
          event: "lan-roster",
          data: {
            region: "Vulkan LAN",
            players: [
              { steam_id: A, name: `player ${A}` },
              { steam_id: B, name: `player ${B}` },
            ],
          },
        },
      ]);
      expect(lanEvents(redis)).toEqual([
        {
          region: "Vulkan LAN",
          joined: [{ steam_id: B, name: `player ${B}` }],
          left: [],
        },
        {
          region: "Vulkan LAN",
          joined: [{ steam_id: A, name: `player ${A}` }],
          left: [],
        },
      ]);
    });

    it("announces a player once however many tabs they have there, and leaves with the last", async () => {
      const { presence, redis } = makePresence();
      const first = tab(A, "client-1", "session-a");
      const second = tab(A, "client-2", "session-a");
      lanProbe(redis, "session-a", [
        { region: "Vulkan LAN", latency: 2, isLan: true },
      ]);

      await presence.syncLan(first);
      await presence.syncLan(second);
      await presence.leaveLan(first);
      expect(lanEvents(redis)).toHaveLength(1);

      await presence.leaveLan(second);
      expect(lanEvents(redis).at(-1)).toEqual({
        region: "Vulkan LAN",
        joined: [],
        left: [A],
      });
    });

    it("takes a tab off its LAN when the probe stops finding it there", async () => {
      const { presence, redis } = makePresence();
      const client = tab(A, "client-1");
      lanProbe(redis, client.sessionId, [
        { region: "Vulkan LAN", latency: 2, isLan: true },
      ]);
      await presence.syncLan(client);

      lanProbe(redis, client.sessionId, [
        { region: "Europe", latency: 20, isLan: false },
      ]);
      await presence.syncLan(client);
      await presence.syncLan(client);

      expect(sent(client).at(-1)).toEqual({
        event: "lan-roster",
        data: { region: null, players: [] },
      });
      expect(sent(client)).toHaveLength(2);
      expect(lanEvents(redis).at(-1)).toEqual({
        region: "Vulkan LAN",
        joined: [],
        left: [A],
      });
    });

    it("keeps a tab that closed before its LAN was found off the LAN", async () => {
      const { presence, redis } = makePresence();
      const client = tab(A, "client-1");
      lanProbe(redis, client.sessionId, [
        { region: "Vulkan LAN", latency: 2, isLan: true },
      ]);

      await presence.leaveLan(client);
      await presence.syncLan(client);

      expect(lanEvents(redis)).toEqual([]);
      expect(sent(client)).toEqual([]);
    });
  });

  it("sweeps out players and LAN tabs whose presence expired, telling who it concerns", async () => {
    const { presence, redis } = makePresence({
      [A]: { friends: [[A, B]], team: [] },
    });
    online(redis, A, B);
    const client = tab(A, "client-1");
    lanProbe(redis, client.sessionId, [
      { region: "Vulkan LAN", latency: 2, isLan: true },
    ]);
    await presence.syncLan(client);
    redis.strings.set(`clients:${B}:pod-1:client-9`, "1");
    redis.strings.delete(`players:${A}`);
    redis.published = [];

    await presence.sweep();
    presence.onApplicationShutdown();

    expect(await redis.zrange(PresenceService.ONLINE)).toEqual([B]);
    expect(toSteamIds(redis)).toEqual([[B, false]]);
    expect(lanEvents(redis)).toEqual([
      { region: "Vulkan LAN", joined: [], left: [A] },
    ]);
  });
});
