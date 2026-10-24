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
  async zrevrange(key: string) {
    return [...this.zsetOf(key).entries()]
      .sort(([memberA, a], [memberB, b]) =>
        b === a ? memberB.localeCompare(memberA) : b - a,
      )
      .flatMap(([member, score]) => [member, String(score)]);
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
  listMax?: string,
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
  const postgres = {
    query: jest.fn(async () =>
      listMax === undefined ? [] : [{ value: listMax }],
    ),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const presence = new PresenceService(
    logger as any,
    { getConnection: () => redis } as any,
    hasura as any,
    postgres as any,
  );
  return { presence, redis, hasura, postgres };
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
        { event: "players-online:listed", data: true },
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

  describe("everyone online", () => {
    const arrive = (redis: FakeRedis, steamId: string, at: number) => {
      redis.zsets.set(
        PresenceService.ONLINE,
        new Map([
          ...(redis.zsets.get(PresenceService.ONLINE) ?? new Map()),
          [steamId, at],
        ]),
      );
    };

    const pages = (
      client: any,
    ): Array<{
      requestId: string;
      listed: boolean;
      players: string[];
      next: string | null;
    }> =>
      sent(client)
        .filter(({ event }: any) => event === "players-online:page")
        .map(({ data }: any) => ({
          ...data,
          players: data.players.map(({ steam_id }: any) => steam_id),
        }));

    const players = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `76561198100000${String(index).padStart(3, "0")}`,
      );

    it("reads the limit from its setting, 200 when unset or unreadable", () => {
      expect(PresenceService.listMaxFrom(undefined)).toBe(200);
      expect(PresenceService.listMaxFrom(null)).toBe(200);
      expect(PresenceService.listMaxFrom(" ")).toBe(200);
      expect(PresenceService.listMaxFrom("lots")).toBe(200);
      expect(PresenceService.listMaxFrom("-5")).toBe(200);
      expect(PresenceService.listMaxFrom("0")).toBe(0);
      expect(PresenceService.listMaxFrom("50.7")).toBe(50);
    });

    it("pages newest first without the asker, 25 at a time", async () => {
      const { presence, redis } = makePresence();
      const everyone = players(30);
      everyone.forEach((steamId, index) => arrive(redis, steamId, index + 1));
      arrive(redis, A, 100);
      const client = tab(A, "client-1");

      await presence.page(client, { requestId: "r-1" });
      const [first] = pages(client);
      await presence.page(client, { requestId: "r-2", after: first.next });
      const [, second] = pages(client);

      const newestFirst = [...everyone].reverse();
      expect(first).toEqual({
        requestId: "r-1",
        listed: true,
        players: newestFirst.slice(0, 25),
        next: `6:${everyone[5]}`,
      });
      expect(second).toEqual({
        requestId: "r-2",
        listed: true,
        players: newestFirst.slice(25),
        next: null,
      });
    });

    it("never repeats or skips anyone when players come and go between pages", async () => {
      const { presence, redis } = makePresence();
      const everyone = players(30);
      everyone.forEach((steamId, index) => arrive(redis, steamId, index + 1));
      const client = tab(A, "client-1");
      await presence.page(client, { requestId: "r-1" });
      const [first] = pages(client);

      arrive(redis, B, 200);
      arrive(redis, C, 201);
      await redis.zrem(PresenceService.ONLINE, everyone[29]);
      await redis.zrem(PresenceService.ONLINE, everyone[3]);
      await presence.page(client, { requestId: "r-2", after: first.next });

      expect(pages(client)[1].players).toEqual([
        everyone[4],
        everyone[2],
        everyone[1],
        everyone[0],
      ]);
    });

    it("keeps the order of players who came online in the same millisecond", async () => {
      const { presence, redis } = makePresence();
      const everyone = players(27);
      everyone.forEach((steamId) => arrive(redis, steamId, 5));
      const client = tab(A, "client-1");

      await presence.page(client, { requestId: "r-1" });
      await presence.page(client, {
        requestId: "r-2",
        after: pages(client)[0].next,
      });

      expect(pages(client).flatMap(({ players }) => players)).toEqual(
        [...everyone].reverse(),
      );
    });

    it("searches everyone online by name and pages the matches", async () => {
      const { presence, redis } = makePresence();
      const everyone = players(60);
      everyone.forEach((steamId, index) => {
        arrive(redis, steamId, index + 1);
        redis.strings.set(
          PresenceService.PROFILE_KEY(steamId),
          JSON.stringify({
            steam_id: steamId,
            name: index % 2 ? `Bravo ${index}` : `Alpha ${index}`,
          }),
        );
      });
      const client = tab(A, "client-1");

      await presence.page(client, { requestId: "r-1", query: " ALPHA " });
      const [first] = pages(client);
      await presence.page(client, {
        requestId: "r-2",
        query: "alpha",
        after: first.next,
      });
      await presence.page(client, { requestId: "r-3", query: everyone[7] });

      const alphas = everyone.filter((_, index) => index % 2 === 0).reverse();
      expect(pages(client).map(({ players }) => players)).toEqual([
        alphas.slice(0, 25),
        alphas.slice(25),
        [everyone[7]],
      ]);
      expect(pages(client)[1].next).toBeNull();
    });

    it("lists no one once more are online than the setting allows, or when it is 0", async () => {
      const over = makePresence({}, "2");
      online(over.redis, A, B, C);
      const client = tab(A, "client-1");
      await over.presence.page(client, { requestId: "r-1" });

      const off = makePresence({}, "0");
      online(off.redis, A, B);
      const other = tab(A, "client-2");
      await off.presence.page(other, { requestId: "r-2" });
      await off.presence.welcome(other);

      expect(pages(client)).toEqual([
        { requestId: "r-1", listed: false, players: [], next: null },
      ]);
      expect(pages(other)).toEqual([
        { requestId: "r-2", listed: false, players: [], next: null },
      ]);
      expect(sent(other)).toContainEqual({
        event: "players-online:listed",
        data: false,
      });
    });

    it("comes back only once 10% under the limit after going over it", async () => {
      const { presence, redis } = makePresence({}, "10");
      const client = tab(A, "client-1");
      const listedNow = async () => {
        await presence.page(client, { requestId: "r" });
        return pages(client).at(-1)!.listed;
      };
      const crowd = players(11);

      online(redis, ...crowd.slice(0, 10));
      expect(await listedNow()).toBe(true);
      online(redis, crowd[10]);
      expect(await listedNow()).toBe(false);
      await redis.zrem(PresenceService.ONLINE, crowd[10]);
      expect(await listedNow()).toBe(false);
      await redis.zrem(PresenceService.ONLINE, crowd[9]);
      expect(await listedNow()).toBe(true);
      online(redis, crowd[9]);
      expect(await listedNow()).toBe(true);
    });

    it("reads the setting once in a while, not on every arrival", async () => {
      const { presence, postgres } = makePresence();

      await presence.cameOnline(A);
      await presence.cameOnline(B);
      await presence.wentOffline(A);
      presence.onApplicationShutdown();

      expect(postgres.query).toHaveBeenCalledTimes(1);
    });

    it("tells the tabs showing the list who came and went while it is listed", async () => {
      const { presence, redis } = makePresence({}, "2");
      const watched = () =>
        redis.published
          .filter(({ channel }) => channel === "online-message")
          .map(({ message }) => message);

      await presence.cameOnline(A);
      await presence.cameOnline(B);
      await presence.cameOnline(C);
      await presence.wentOffline(C);
      await presence.wentOffline(B);
      presence.onApplicationShutdown();

      expect(watched()).toEqual([
        { event: "online-presence", data: { steam_id: A, online: true } },
        { event: "online-presence", data: { steam_id: B, online: true } },
        { event: "online-presence", data: { steam_id: B, online: false } },
      ]);
    });

    it("says whether everyone is listed whenever it sends the count", async () => {
      jest.useFakeTimers();
      const { presence, redis } = makePresence({}, "1");
      const broadcasts = () =>
        redis.published
          .filter(({ channel }) => channel === "broadcast-message")
          .map(({ message }) => message);

      await presence.cameOnline(A);
      await jest.advanceTimersByTimeAsync(0);
      await presence.cameOnline(B);
      await jest.advanceTimersByTimeAsync(PresenceService.COUNT_INTERVAL_MS);
      presence.onApplicationShutdown();

      expect(broadcasts()).toEqual([
        { event: "players-online:count", data: 1 },
        { event: "players-online:listed", data: true },
        { event: "players-online:count", data: 2 },
        { event: "players-online:listed", data: false },
      ]);
    });

    it("marks which tabs are showing the list", () => {
      const { presence } = makePresence();
      const client = tab(A, "client-1");

      presence.watch(client, { watching: true });
      expect(client.watchingOnline).toBe(true);
      presence.watch(client, { watching: "yes" });
      expect(client.watchingOnline).toBe(false);
    });
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
