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

  const service = new SocketsService(
    logger as any,
    { get: () => ({ name: "5stack", encSecret: "secret" }) } as any,
    matchmaking as any,
    { getConnection: () => redis } as any,
    lobbies as any,
    { emit: jest.fn() } as any,
    demoSessionWatcher as any,
  );

  return { service, redis, matchmaking, lobbies, logger, demoSessionWatcher };
}

function socket(readyState = 1) {
  return {
    readyState,
    OPEN: 1,
    terminate: jest.fn(),
    close: jest.fn(),
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
      20,
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
