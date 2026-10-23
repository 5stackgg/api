const sessionLoad: {
  impl: (request: any, next: (error?: unknown) => void) => void;
} = {
  impl: (_request, next) => next(),
};

jest.mock("express-session", () =>
  jest.fn(
    () => (request: any, _response: any, next: any) =>
      sessionLoad.impl(request, next),
  ),
);

jest.mock("connect-redis", () => jest.fn());

jest.mock("passport", () => ({
  session: () => (_request: any, _response: any, next: any) => next(),
}));

import { SocketsService } from "./sockets.service";

const USER = { steam_id: "76561198000000001", name: "Luke", role: "user" };

function makeService() {
  const redis = {
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    hdel: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  };
  const matchmaking = {
    cancelOffline: jest.fn().mockResolvedValue(undefined),
    sendRegionStats: jest.fn().mockResolvedValue(undefined),
    markOffline: jest.fn(),
  };
  const lobbies = {
    sendQueueDetailsToPlayer: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const demoSessionWatcher = { clientClosed: jest.fn() };
  const hasura = { getPlayerRole: jest.fn().mockResolvedValue("user") };

  const service = new SocketsService(
    logger as any,
    { get: () => ({ name: "5stack", encSecret: "secret" }) } as any,
    matchmaking as any,
    { getConnection: () => redis } as any,
    lobbies as any,
    { emit: jest.fn() } as any,
    demoSessionWatcher as any,
    hasura as any,
  );

  return {
    service,
    redis,
    matchmaking,
    lobbies,
    logger,
    demoSessionWatcher,
    hasura,
  };
}

function socket(readyState = 1) {
  return {
    readyState,
    OPEN: 1,
    terminate: jest.fn(),
    close: jest.fn(),
    ping: jest.fn(),
    on: jest.fn(),
    send: jest.fn(),
  } as any;
}

function signIn(user: typeof USER | undefined) {
  sessionLoad.impl = (request, next) => {
    request.user = user;
    request.session = { id: "session-1" };
    next();
  };
}

describe("SocketsService.setupSocket", () => {
  afterEach(() => {
    sessionLoad.impl = (_request, next) => next();
    jest.useRealTimers();
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const closeListener = (client: any) =>
    client.on.mock.calls.find(([event]: [string]) => event === "close")[1];

  it("sets up a signed-in socket and then welcomes it", async () => {
    const { service, redis, matchmaking, lobbies } = makeService();
    const client = socket();
    signIn(USER);

    await service.setupSocket(client, {} as any);

    expect(client.user).toBe(USER);
    expect(client.sessionId).toBe("session-1");
    expect(client.id).toEqual(expect.any(String));
    expect(client.peerNodes).toEqual(new Set());
    expect(client.signalPeers).toEqual(new Map());
    expect(client.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(client.terminate).not.toHaveBeenCalled();

    await settle();

    expect(redis.set).toHaveBeenCalledWith(
      `clients:${USER.steam_id}:${undefined}:${client.id}`,
      "1",
      "EX",
      expect.any(Number),
    );
    expect(matchmaking.cancelOffline).toHaveBeenCalledWith(USER.steam_id);
    expect(lobbies.sendQueueDetailsToPlayer).toHaveBeenCalledWith(
      USER.steam_id,
    );
  });

  it("does not hold the socket's messages behind its welcome", async () => {
    const { service, matchmaking } = makeService();
    const client = socket();
    matchmaking.sendRegionStats.mockReturnValue(new Promise(() => {}));
    signIn(USER);

    await service.setupSocket(client, {} as any);

    expect(client.user).toBe(USER);
  });

  it("leaves a socket that closed while its session loaded unauthenticated", async () => {
    const { service, redis, matchmaking } = makeService();
    const client = socket(3);
    signIn(USER);

    await service.setupSocket(client, {} as any);
    await settle();

    expect(client.user).toBeUndefined();
    expect(client.terminate).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(matchmaking.cancelOffline).not.toHaveBeenCalled();
  });

  it("cleans up a socket that closes while it registers, once it has registered", async () => {
    const { service, redis, matchmaking, demoSessionWatcher } = makeService();
    const client = socket();
    let finishRegistering: () => void;
    matchmaking.cancelOffline.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRegistering = resolve;
      }),
    );
    signIn(USER);

    await service.setupSocket(client, {} as any);
    await settle();

    const closed = closeListener(client)();

    expect(demoSessionWatcher.clientClosed).toHaveBeenCalledWith(client.id);
    await settle();
    expect(redis.del).not.toHaveBeenCalled();
    expect(matchmaking.markOffline).not.toHaveBeenCalled();

    finishRegistering();
    await closed;

    expect(redis.del).toHaveBeenCalledWith(
      `clients:${USER.steam_id}:${undefined}:${client.id}`,
    );
    expect(matchmaking.markOffline).toHaveBeenCalledWith(USER.steam_id);
    expect(matchmaking.cancelOffline.mock.invocationCallOrder[0]).toBeLessThan(
      matchmaking.markOffline.mock.invocationCallOrder[0],
    );
  });

  it("cleans up a socket that closes while its welcome hangs", async () => {
    const { service, redis, matchmaking } = makeService();
    const client = socket();
    matchmaking.sendRegionStats.mockReturnValue(new Promise(() => {}));
    signIn(USER);

    await service.setupSocket(client, {} as any);
    await settle();

    await closeListener(client)();

    expect(redis.del).toHaveBeenCalledWith(
      `clients:${USER.steam_id}:${undefined}:${client.id}`,
    );
    expect(matchmaking.markOffline).toHaveBeenCalledWith(USER.steam_id);
  });

  it("terminates a socket without a signed-in session", async () => {
    const { service, matchmaking } = makeService();
    const client = socket();
    signIn(undefined);

    await service.setupSocket(client, {} as any);

    expect(client.terminate).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.user).toBeUndefined();
    expect(matchmaking.cancelOffline).not.toHaveBeenCalled();
  });

  it("terminates a socket whose session could not be loaded", async () => {
    const { service } = makeService();
    const client = socket();
    sessionLoad.impl = (_request, next) => next(new Error("redis down"));

    await service.setupSocket(client, {} as any);

    expect(client.terminate).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.user).toBeUndefined();
  });

  it("gives up on a session load that stalls", async () => {
    jest.useFakeTimers();
    const { service } = makeService();
    const client = socket();
    sessionLoad.impl = () => {};

    const setup = service.setupSocket(client, {} as any);

    await jest.advanceTimersByTimeAsync(9_999);
    expect(client.terminate).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await setup;

    expect(client.terminate).toHaveBeenCalledTimes(1);
    expect(client.user).toBeUndefined();
  });

  it("keeps a signed-in socket when its welcome fails", async () => {
    const { service, matchmaking, logger } = makeService();
    const client = socket();
    matchmaking.sendRegionStats.mockRejectedValue(new Error("hasura down"));
    signIn(USER);

    await expect(
      service.setupSocket(client, {} as any),
    ).resolves.toBeUndefined();
    await settle();

    expect(client.user).toBe(USER);
    expect(client.terminate).not.toHaveBeenCalled();
    expect(client.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("SocketsService.sendMessageToSteamId", () => {
  const OTHER = { ...USER, steam_id: "76561198000000002", name: "Other" };

  afterEach(() => {
    sessionLoad.impl = (_request, next) => next();
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const closeListener = (client: any) =>
    client.on.mock.calls.find(([event]: [string]) => event === "close")[1];

  async function connect(
    service: SocketsService,
    user: typeof USER,
  ): Promise<any> {
    const client = socket();
    signIn(user);
    await service.setupSocket(client, {} as any);
    await settle();
    return client;
  }

  async function publish(
    redis: ReturnType<typeof makeService>["redis"],
    steamId: string | number,
    event: string,
    data: unknown,
  ) {
    const onMessage = redis.on.mock.calls.find(
      ([event]: [string]) => event === "message",
    )[1];
    onMessage(
      "send-message-to-steam-id",
      JSON.stringify({ steamId, event, data }),
    );
    await settle();
  }

  const sent = (event: string, data: unknown) =>
    JSON.stringify({ event, data });

  it("reaches an open socket whose presence key has expired", async () => {
    const { service, redis } = makeService();
    const client = await connect(service, USER);

    redis.keys.mockResolvedValue([]);

    await publish(redis, USER.steam_id, "matchmaking:details", { ready: 1 });

    expect(client.send).toHaveBeenCalledWith(
      sent("matchmaking:details", { ready: 1 }),
    );
  });

  it("reaches every open tab of the player and nobody else", async () => {
    const { service, redis } = makeService();
    const first = await connect(service, USER);
    const second = await connect(service, USER);
    const other = await connect(service, OTHER);

    await publish(redis, USER.steam_id, "direct:incoming", { id: 1 });

    expect(first.send).toHaveBeenCalledWith(sent("direct:incoming", { id: 1 }));
    expect(second.send).toHaveBeenCalledWith(
      sent("direct:incoming", { id: 1 }),
    );
    expect(other.send).not.toHaveBeenCalledWith(
      sent("direct:incoming", { id: 1 }),
    );
  });

  it("matches a steam id published as a number", async () => {
    const { service, redis } = makeService();
    const client = await connect(service, { ...USER, steam_id: "42" });

    await publish(redis, 42, "matchmaking:details", {});

    expect(client.send).toHaveBeenCalledWith(sent("matchmaking:details", {}));
  });

  it("keeps the remaining tab after another one closes", async () => {
    const { service, redis } = makeService();
    const closing = await connect(service, USER);
    const staying = await connect(service, USER);

    await closeListener(closing)();
    await publish(redis, USER.steam_id, "matchmaking:details", {});

    expect(closing.send).not.toHaveBeenCalled();
    expect(staying.send).toHaveBeenCalledWith(sent("matchmaking:details", {}));
  });

  it("forgets a player once their last tab closes", async () => {
    const { service, redis } = makeService();
    const first = await connect(service, USER);
    const second = await connect(service, USER);

    await closeListener(first)();
    await closeListener(second)();
    await publish(redis, USER.steam_id, "matchmaking:details", {});

    expect(first.send).not.toHaveBeenCalledWith(
      sent("matchmaking:details", {}),
    );
    expect(second.send).not.toHaveBeenCalledWith(
      sent("matchmaking:details", {}),
    );
    expect((service as any).clientsBySteamId.size).toBe(0);
  });

  it("never indexes a socket that closed while its session loaded", async () => {
    const { service, redis } = makeService();
    const client = socket(3);
    signIn(USER);

    await service.setupSocket(client, {} as any);
    await settle();
    await publish(redis, USER.steam_id, "matchmaking:details", {});

    expect(client.send).not.toHaveBeenCalled();
    expect((service as any).clientsBySteamId.size).toBe(0);
  });
});

describe("SocketsService presence", () => {
  // what a tab hidden for a few minutes manages
  const HIDDEN_TAB_PING_SECONDS = 60;

  afterEach(() => {
    sessionLoad.impl = (_request, next) => next();
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const closeListener = (client: any) =>
    client.on.mock.calls.find(([event]: [string]) => event === "close")[1];

  async function connect(service: SocketsService): Promise<any> {
    const client = socket();
    signIn(USER);
    await service.setupSocket(client, {} as any);
    await settle();
    return client;
  }

  const ttlOf = (redis: ReturnType<typeof makeService>["redis"], key: string) =>
    redis.set.mock.calls.find(([written]: [string]) => written === key)[3];

  it("outlasts the heartbeat of a hidden tab", async () => {
    const { service, redis } = makeService();

    await service.updateClient(USER.steam_id, "client-1");

    expect(ttlOf(redis, `players:${USER.steam_id}`)).toBeGreaterThan(
      HIDDEN_TAB_PING_SECONDS * 2,
    );
    expect(
      ttlOf(redis, `clients:${USER.steam_id}:${undefined}:client-1`),
    ).toBeGreaterThan(HIDDEN_TAB_PING_SECONDS * 2);
  });

  it("keeps a player online when a tab closes while another stays open on this pod", async () => {
    const { service, redis, matchmaking } = makeService();
    const closing = await connect(service);
    await connect(service);

    // the other tab is hidden and its presence key has lapsed
    redis.keys.mockResolvedValue([]);

    await closeListener(closing)();

    expect(matchmaking.markOffline).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalledWith(`players:${USER.steam_id}`);
  });

  it("puts a player who dropped out of presence back online on their next ping", async () => {
    const { service, redis, matchmaking } = makeService();
    // SET ... GET finds no presence left
    redis.set.mockResolvedValueOnce(null);

    await service.heartbeat(USER.steam_id, "client-1");

    expect(redis.set).toHaveBeenCalledWith(
      `players:${USER.steam_id}`,
      expect.any(String),
      "EX",
      expect.any(Number),
      "GET",
    );
    expect(matchmaking.cancelOffline).toHaveBeenCalledWith(USER.steam_id);
    expect(redis.publish).toHaveBeenCalledWith(
      "broadcast-message",
      expect.stringContaining("players-online"),
    );
  });

  it("takes a demoted player's old role off their open socket on its next ping", async () => {
    const { service, hasura } = makeService();
    const client = socket();
    signIn({ ...USER, role: "administrator" });
    await service.setupSocket(client, {} as any);
    await settle();

    hasura.getPlayerRole.mockResolvedValue("user");
    await service.heartbeat(USER.steam_id, client.id);

    expect(client.user.role).toBe("user");
  });

  it("closes the socket of a player who no longer exists on its next ping", async () => {
    const { service, hasura, matchmaking } = makeService();
    const client = socket();
    signIn({ ...USER });
    await service.setupSocket(client, {} as any);
    await settle();
    matchmaking.cancelOffline.mockClear();

    hasura.getPlayerRole.mockResolvedValue(undefined);
    await service.heartbeat(USER.steam_id, client.id);

    expect(client.close).toHaveBeenCalled();
    expect(matchmaking.cancelOffline).not.toHaveBeenCalled();
  });

  it("puts a player back online when their frozen tab answers a protocol ping", async () => {
    const { service, redis, matchmaking } = makeService();
    const client = await connect(service);
    const pong = client.on.mock.calls.find(
      ([event]: [string]) => event === "pong",
    )[1];
    matchmaking.cancelOffline.mockClear();
    redis.publish.mockClear();
    redis.set.mockResolvedValueOnce(null);
    redis.keys.mockResolvedValue([`players:${USER.steam_id}`]);

    pong();
    await settle();

    expect(matchmaking.cancelOffline).toHaveBeenCalledWith(USER.steam_id);
    expect(redis.publish).toHaveBeenCalledWith(
      "broadcast-message",
      expect.stringContaining("players-online"),
    );
  });

  it("leaves the offline job alone on the ping of a player who is online", async () => {
    const { service, matchmaking, redis } = makeService();
    redis.set.mockResolvedValueOnce(JSON.stringify({ lastSeen: 1 }));

    await service.heartbeat(USER.steam_id, "client-1");

    expect(matchmaking.cancelOffline).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });
});

describe("SocketsService players online", () => {
  afterEach(() => {
    sessionLoad.impl = (_request, next) => next();
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const rosters = (redis: ReturnType<typeof makeService>["redis"]) =>
    redis.publish.mock.calls
      .filter(([channel]: [string]) => channel === "broadcast-message")
      .map(([, message]: [string, string]) => JSON.parse(message))
      .filter(({ event }: { event: string }) => event === "players-online")
      .map(({ data }: { data: string[] }) => data);

  it("broadcasts the roster only when it changes", async () => {
    const { service, redis } = makeService();
    redis.keys.mockResolvedValue(["players:2", "players:1"]);

    await service.sendPeopleOnline();
    await service.sendPeopleOnline();
    redis.keys.mockResolvedValue(["players:1", "players:2"]);
    await service.sendPeopleOnline();
    redis.keys.mockResolvedValue(["players:1", "players:2", "players:3"]);
    await service.sendPeopleOnline();

    expect(rosters(redis)).toEqual([
      ["1", "2"],
      ["1", "2", "3"],
    ]);
  });

  it("does not resend a roster another pod already broadcast", async () => {
    const { service, redis } = makeService();
    const onMessage = redis.on.mock.calls.find(
      ([event]: [string]) => event === "message",
    )[1];
    redis.keys.mockResolvedValue(["players:1"]);

    onMessage(
      "broadcast-message",
      JSON.stringify({ event: "players-online", data: ["1"] }),
    );
    await service.sendPeopleOnline();

    expect(rosters(redis)).toEqual([]);
  });

  it("sends a tab that connects the roster without rebroadcasting an unchanged one", async () => {
    const { service, redis } = makeService();
    redis.keys.mockResolvedValue([`players:${USER.steam_id}`]);
    signIn(USER);

    const first = socket();
    await service.setupSocket(first, {} as any);
    await settle();
    const second = socket();
    await service.setupSocket(second, {} as any);
    await settle();

    expect(rosters(redis)).toEqual([[USER.steam_id]]);
    expect(second.send).toHaveBeenCalledWith(
      JSON.stringify({ event: "players-online", data: [USER.steam_id] }),
    );
  });
});

describe("SocketsService offline", () => {
  afterEach(() => {
    sessionLoad.impl = (_request, next) => next();
    jest.useRealTimers();
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const closeListener = (client: any) =>
    client.on.mock.calls.find(([event]: [string]) => event === "close")[1];

  async function connect(service: SocketsService): Promise<any> {
    const client = socket();
    signIn(USER);
    await service.setupSocket(client, {} as any);
    await settle();
    return client;
  }

  // A reload's new socket registers while the old one is closing; whatever it
  // cancels has to be queued already.
  it("queues the offline job before anyone can see the player gone", async () => {
    const { service, redis, matchmaking } = makeService();
    redis.keys.mockResolvedValue([`players:${USER.steam_id}`]);
    const client = await connect(service);
    redis.keys.mockResolvedValue([]);

    await closeListener(client)();

    const queued = matchmaking.markOffline.mock.invocationCallOrder[0];
    const removed =
      redis.del.mock.invocationCallOrder[
        redis.del.mock.calls.findIndex(
          ([key]: [string]) => key === `players:${USER.steam_id}`,
        )
      ];
    const announced = redis.publish.mock.invocationCallOrder.at(-1);

    expect(queued).toBeLessThan(removed);
    expect(queued).toBeLessThan(announced);
  });

  it("counts a tab on a pod that has died as gone", async () => {
    const { service, redis, matchmaking } = makeService();
    const client = await connect(service);
    redis.keys.mockResolvedValue([
      `clients:${USER.steam_id}:dead-pod:client-9`,
    ]);
    redis.exists.mockImplementation(async (key: string) =>
      key === "sockets:pod:dead-pod" ? 0 : 1,
    );

    await closeListener(client)();

    expect(matchmaking.markOffline).toHaveBeenCalledWith(USER.steam_id);
  });

  it("keeps a player online while a tab of theirs is on a live pod", async () => {
    const { service, redis, matchmaking } = makeService();
    const client = await connect(service);
    redis.keys.mockResolvedValue([
      `clients:${USER.steam_id}:other-pod:client-9`,
    ]);

    await closeListener(client)();

    expect(matchmaking.markOffline).not.toHaveBeenCalled();
  });

  it("keeps this pod marked alive", async () => {
    jest.useFakeTimers();
    const { service, redis } = makeService();
    const podWrites = () =>
      redis.set.mock.calls.filter(
        ([key]: [string]) => key === `sockets:pod:${undefined}`,
      );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(podWrites()).toHaveLength(1);
    const [, , ex, ttl] = podWrites()[0];
    expect(ex).toBe("EX");
    expect(ttl).toBeLessThanOrEqual(30);

    await jest.advanceTimersByTimeAsync((ttl * 1000) / 2);
    expect(podWrites().length).toBeGreaterThan(1);

    service.onApplicationShutdown();
  });

  it("drops a socket that has been silent for longer than presence lasts", async () => {
    const { service } = makeService();
    const silent = await connect(service);
    const pinging = await connect(service);

    jest.useFakeTimers({
      now: Date.now(),
      doNotFake: ["setImmediate", "nextTick"],
    });
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(100 * 1000);
    await service.heartbeat(USER.steam_id, pinging.id);
    await jest.advanceTimersByTimeAsync(60 * 1000);

    expect(silent.terminate).toHaveBeenCalled();
    expect(pinging.terminate).not.toHaveBeenCalled();

    service.onApplicationShutdown();
  });

  it("keeps a tab whose page has stopped pinging while the browser still answers for it", async () => {
    const { service } = makeService();
    const frozen = await connect(service);
    const pinging = await connect(service);
    const pong = frozen.on.mock.calls.find(
      ([event]: [string]) => event === "pong",
    )[1];
    frozen.ping.mockImplementation(() => pong());

    jest.useFakeTimers({
      now: Date.now(),
      doNotFake: ["setImmediate", "nextTick"],
    });
    service.onModuleInit();

    for (let elapsed = 0; elapsed < 300; elapsed += 10) {
      await service.heartbeat(USER.steam_id, pinging.id);
      await jest.advanceTimersByTimeAsync(10 * 1000);
    }

    expect(frozen.ping).toHaveBeenCalled();
    expect(frozen.terminate).not.toHaveBeenCalled();
    expect(pinging.ping).not.toHaveBeenCalled();

    service.onApplicationShutdown();
  });
});
