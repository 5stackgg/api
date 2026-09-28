// Isolate the gateway from its heavy DI imports.
jest.mock("./events", () => {
  class TestEvent {}
  return {
    MatchEvents: Object.fromEntries(
      [
        "testEvent",
        "mapStatus",
        "chat",
        "player-disconnected",
        "surrender",
        "score",
        "restoreRound",
        "techTimeout",
        "kill",
      ].map((name) => [name, TestEvent]),
    ),
  };
});
jest.mock("src/hasura/hasura.service", () => ({ HasuraService: class {} }));
jest.mock("src/cache/cache.service", () => ({ CacheService: class {} }));

import {
  FiveStackGameServerWebSocketClient,
  MatchEventsGateway,
} from "./match-events.gateway";

const SERVER_A = "a0000000-0000-4000-8000-00000000000a";
const SERVER_B = "b0000000-0000-4000-8000-00000000000b";
const MATCH_1 = "10000000-0000-4000-8000-000000000001";
const MATCH_2 = "20000000-0000-4000-8000-000000000002";
const MAP_1 = "11000000-0000-4000-8000-000000000011";
const MAP_2 = "22000000-0000-4000-8000-000000000022";

type MatchRow = {
  server_id: string | null;
  status: string;
  match_maps: Array<{ id: string }>;
};

function makeGateway(
  opts: {
    cacheHit?: boolean;
    processImpl?: () => any;
    matches?: Record<string, MatchRow>;
    servers?: Record<string, { id: string; api_password: string }>;
    serverQuery?: () => Promise<unknown>;
  } = {},
) {
  const store = new Map<string, unknown>();
  const cache = {
    has: jest.fn(
      async (key: string) => (opts.cacheHit ?? false) || store.has(key),
    ),
    get: jest.fn(async (key: string) => store.get(key)),
    put: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return true;
    }),
  };

  const matches: Record<string, MatchRow> = opts.matches ?? {
    [MATCH_1]: {
      server_id: SERVER_A,
      status: "Live",
      match_maps: [{ id: MAP_1 }],
    },
    [MATCH_2]: {
      server_id: SERVER_B,
      status: "Live",
      match_maps: [{ id: MAP_2 }],
    },
  };
  const servers = opts.servers ?? {
    [SERVER_A]: { id: SERVER_A, api_password: "password-a" },
    [SERVER_B]: { id: SERVER_B, api_password: "password-b" },
  };

  const hasura = {
    query: jest.fn(async (query: any) => {
      if (query.servers_by_pk) {
        if (opts.serverQuery) {
          return opts.serverQuery();
        }
        return {
          servers_by_pk: servers[query.servers_by_pk.__args.id] ?? null,
        };
      }
      if (query.matches_by_pk) {
        const row = matches[query.matches_by_pk.__args.id];
        return { matches_by_pk: row ? { ...row } : null };
      }
      throw new Error("unexpected query");
    }),
  };

  const processor = {
    setData: jest.fn(),
    process: jest.fn().mockImplementation(opts.processImpl ?? (async () => {})),
  };
  const moduleRef = { resolve: jest.fn().mockResolvedValue(processor) };
  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
  };
  const gateway = new MatchEventsGateway(
    logger as any,
    moduleRef as any,
    hasura as any,
    cache as any,
  );

  const matchLookups = () =>
    hasura.query.mock.calls.filter(([query]) => query.matches_by_pk).length;

  return {
    gateway,
    cache,
    store,
    hasura,
    matches,
    processor,
    moduleRef,
    logger,
    matchLookups,
  };
}

function socket() {
  return {
    terminate: jest.fn(),
    close: jest.fn(),
  } as unknown as FiveStackGameServerWebSocketClient & {
    terminate: jest.Mock;
    close: jest.Mock;
  };
}

function authedSocket(serverId = SERVER_A) {
  const client = socket();
  client.authenticated = true;
  client.serverId = serverId;
  return client;
}

function basic(serverId: string, password: string) {
  return {
    headers: {
      authorization: `Basic ${Buffer.from(`${serverId}:${password}`).toString("base64")}`,
    },
  } as any;
}

async function connect(
  gateway: MatchEventsGateway,
  client: FiveStackGameServerWebSocketClient,
  request: any,
) {
  gateway.handleConnection(client, request);
  await client.authentication;
}

function event(
  overrides: {
    matchId?: unknown;
    messageId?: string;
    name?: string;
    data?: Record<string, unknown>;
  } = {},
) {
  return {
    matchId: "matchId" in overrides ? overrides.matchId : MATCH_1,
    messageId: overrides.messageId ?? "msg-1",
    data: {
      event: overrides.name ?? "testEvent",
      data: overrides.data ?? {},
    },
  } as any;
}

describe("MatchEventsGateway.handleMatchEvent dedup", () => {
  it("marks the event processed only after process() succeeds", async () => {
    const { gateway, cache, processor } = makeGateway();
    const result = await gateway.handleMatchEvent(authedSocket(), event());

    expect(processor.process).toHaveBeenCalledTimes(1);
    const dedupPut = cache.put.mock.calls.findIndex(([key]) =>
      key.endsWith(":msg-1"),
    );
    expect(dedupPut).toBeGreaterThanOrEqual(0);
    expect(processor.process.mock.invocationCallOrder[0]).toBeLessThan(
      cache.put.mock.invocationCallOrder[dedupPut],
    );
    expect(result).toBe("msg-1");
  });

  it("does NOT write the dedup entry when process() throws (so redelivery retries)", async () => {
    const { gateway, store, processor } = makeGateway({
      processImpl: async () => {
        throw new Error("hasura down");
      },
    });

    await expect(
      gateway.handleMatchEvent(authedSocket(), event()),
    ).rejects.toThrow("hasura down");
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(store.has(`match-events:${MATCH_1}:msg-1`)).toBe(false);
  });

  it("short-circuits on a dedup hit without processing", async () => {
    const { gateway, processor } = makeGateway({ cacheHit: true });
    const result = await gateway.handleMatchEvent(authedSocket(), event());

    expect(result).toBe("msg-1");
    expect(processor.process).not.toHaveBeenCalled();
  });
});

describe("MatchEventsGateway.handleConnection", () => {
  it("authenticates a server with the right password", async () => {
    const { gateway } = makeGateway();
    const client = socket();

    await connect(gateway, client, basic(SERVER_A, "password-a"));

    expect(client.authenticated).toBe(true);
    expect(client.serverId).toBe(SERVER_A);
    expect(client.terminate).not.toHaveBeenCalled();
  });

  it.each([
    ["no header", { headers: {} }],
    ["a non-basic header", { headers: { authorization: "Bearer x" } }],
    ["an empty basic header", { headers: { authorization: "Basic " } }],
    [
      "credentials without a colon",
      {
        headers: {
          authorization: `Basic ${Buffer.from("nocolon").toString("base64")}`,
        },
      },
    ],
    ["the wrong password", basic(SERVER_A, "password-b")],
    ["an unknown server", basic(MATCH_1, "password-a")],
  ])("terminates on %s", async (_, request) => {
    const { gateway } = makeGateway();
    const client = socket();

    await connect(gateway, client, request);

    expect(client.terminate).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.authenticated).toBeFalsy();
    expect(client.serverId).toBeUndefined();
  });

  it("terminates when the server lookup throws", async () => {
    const { gateway } = makeGateway({
      serverQuery: async () => {
        throw new Error("invalid uuid");
      },
    });
    const client = socket();

    await connect(gateway, client, basic("not-a-uuid", "x"));

    expect(client.terminate).toHaveBeenCalledTimes(1);
    expect(client.authenticated).toBeFalsy();
  });
});

describe("MatchEventsGateway unauthenticated clients", () => {
  function pendingAuth() {
    let resolveServer: (value: unknown) => void;
    const harness = makeGateway({
      serverQuery: () =>
        new Promise((resolve) => {
          resolveServer = resolve;
        }),
    });
    return {
      ...harness,
      finishAuth: () =>
        resolveServer({
          servers_by_pk: { id: SERVER_A, api_password: "password-a" },
        }),
    };
  }

  it("never processes events sent while auth is pending or after it failed", async () => {
    const { gateway, processor, moduleRef, matchLookups, finishAuth } =
      pendingAuth();
    const client = socket();

    gateway.handleConnection(client, basic(SERVER_A, "wrong"));

    const raced = gateway.handleMatchEvent(client, event());
    expect(processor.process).not.toHaveBeenCalled();

    finishAuth();

    await expect(raced).resolves.toBeUndefined();
    expect(client.terminate).toHaveBeenCalledTimes(1);

    await expect(
      gateway.handleMatchEvent(client, event({ messageId: "msg-2" })),
    ).resolves.toBeUndefined();

    expect(matchLookups()).toBe(0);
    expect(moduleRef.resolve).not.toHaveBeenCalled();
    expect(processor.process).not.toHaveBeenCalled();
  });

  it("holds events sent while auth is pending and processes them once it succeeds", async () => {
    const { gateway, processor, finishAuth } = pendingAuth();
    const client = socket();

    gateway.handleConnection(client, basic(SERVER_A, "password-a"));

    const early = gateway.handleMatchEvent(client, event());
    await Promise.resolve();
    expect(processor.process).not.toHaveBeenCalled();

    finishAuth();

    await expect(early).resolves.toBe("msg-1");
    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it("ignores events on a socket that never authenticated", async () => {
    const { gateway, processor } = makeGateway();

    await expect(
      gateway.handleMatchEvent(socket(), event()),
    ).resolves.toBeUndefined();
    expect(processor.process).not.toHaveBeenCalled();
  });
});

describe("MatchEventsGateway match binding", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts an event for the server's own match", async () => {
    const { gateway, processor } = makeGateway();

    const result = await gateway.handleMatchEvent(
      authedSocket(SERVER_A),
      event({ data: { match_map_id: MAP_1 } }),
    );

    expect(result).toBe("msg-1");
    expect(processor.setData).toHaveBeenCalledWith(MATCH_1, {
      match_map_id: MAP_1,
    });
    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it("refuses, acknowledges and warns on an event for another server's match", async () => {
    const { gateway, processor, logger, moduleRef } = makeGateway();

    const result = await gateway.handleMatchEvent(
      authedSocket(SERVER_A),
      event({ matchId: MATCH_2 }),
    );

    expect(result).toBe("msg-1");
    expect(moduleRef.resolve).not.toHaveBeenCalled();
    expect(processor.process).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "game server event refused: match is not hosted by this server",
      expect.objectContaining({ serverId: SERVER_A, matchId: MATCH_2 }),
    );
  });

  it.each(["match_map_id", "map_id"])(
    "refuses its own match when %s names another match's map",
    async (key) => {
      const { gateway, processor } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ name: "techTimeout", data: { [key]: MAP_2 } }),
      );

      expect(processor.process).not.toHaveBeenCalled();
    },
  );

  it("accepts a techTimeout for its own map", async () => {
    const { gateway, processor } = makeGateway();

    await gateway.handleMatchEvent(
      authedSocket(SERVER_A),
      event({ name: "techTimeout", data: { map_id: MAP_1 } }),
    );

    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it.each(["match_map_id", "map_id"])(
    "refuses a %s that is not a string",
    async (key) => {
      const { gateway, processor } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ data: { [key]: { _neq: MAP_1 } } }),
      );

      expect(processor.process).not.toHaveBeenCalled();
    },
  );

  it("passes a null match_map_id through, since it cannot name another match", async () => {
    const { gateway, processor } = makeGateway();

    await gateway.handleMatchEvent(
      authedSocket(SERVER_A),
      event({ data: { match_map_id: null } }),
    );

    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it("refuses a match that does not exist", async () => {
    const { gateway, processor } = makeGateway();

    await gateway.handleMatchEvent(
      authedSocket(SERVER_A),
      event({ matchId: "30000000-0000-4000-8000-000000000003" }),
    );

    expect(processor.process).not.toHaveBeenCalled();
  });

  it.each([["not-a-uuid"], [42], [undefined], [{ id: MATCH_1 }]])(
    "refuses a malformed match id (%p) without querying",
    async (matchId) => {
      const { gateway, processor, matchLookups } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ matchId }),
      );

      expect(matchLookups()).toBe(0);
      expect(processor.process).not.toHaveBeenCalled();
    },
  );

  it("looks the binding up once per connection within its ttl", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { gateway, processor, matchLookups } = makeGateway();
    const client = authedSocket(SERVER_A);

    await gateway.handleMatchEvent(client, event({ messageId: "m1" }));
    await gateway.handleMatchEvent(client, event({ messageId: "m2" }));
    now.mockReturnValue(1_004_999);
    await gateway.handleMatchEvent(client, event({ messageId: "m3" }));

    expect(matchLookups()).toBe(1);
    expect(processor.process).toHaveBeenCalledTimes(3);

    now.mockReturnValue(1_005_001);
    await gateway.handleMatchEvent(client, event({ messageId: "m4" }));

    expect(matchLookups()).toBe(2);
  });

  it("does not let a warm binding for one match admit another match", async () => {
    const { gateway, processor } = makeGateway();
    const client = authedSocket(SERVER_A);

    await gateway.handleMatchEvent(client, event({ messageId: "m1" }));
    await gateway.handleMatchEvent(
      client,
      event({ matchId: MATCH_2, messageId: "m2" }),
    );

    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it("does not let a warm binding admit another match's map", async () => {
    const { gateway, processor } = makeGateway();
    const client = authedSocket(SERVER_A);

    await gateway.handleMatchEvent(
      client,
      event({ messageId: "m1", data: { match_map_id: MAP_1 } }),
    );
    await gateway.handleMatchEvent(
      client,
      event({ messageId: "m2", data: { match_map_id: MAP_2 } }),
    );
    await gateway.handleMatchEvent(
      client,
      event({ messageId: "m3", name: "techTimeout", data: { map_id: MAP_2 } }),
    );

    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it("re-reads a warm binding when the payload names a map it has not seen", async () => {
    const { gateway, matches, processor, matchLookups } = makeGateway();
    const client = authedSocket(SERVER_A);
    const MAP_3 = "33000000-0000-4000-8000-000000000033";

    await gateway.handleMatchEvent(client, event({ messageId: "m1" }));
    matches[MATCH_1].match_maps.push({ id: MAP_3 });
    await gateway.handleMatchEvent(
      client,
      event({ messageId: "m2", data: { match_map_id: MAP_3 } }),
    );

    expect(matchLookups()).toBe(2);
    expect(processor.process).toHaveBeenCalledTimes(2);
  });

  it("drops a warm binding as soon as a re-read finds the match moved", async () => {
    const { gateway, matches, processor } = makeGateway();
    const client = authedSocket(SERVER_A);

    await gateway.handleMatchEvent(client, event({ messageId: "m1" }));
    matches[MATCH_1].server_id = SERVER_B;
    await gateway.handleMatchEvent(
      client,
      event({ messageId: "m2", data: { match_map_id: MAP_2 } }),
    );
    await gateway.handleMatchEvent(client, event({ messageId: "m3" }));

    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it("does not cache a refusal", async () => {
    const { gateway, matchLookups, matches, processor } = makeGateway();
    const client = authedSocket(SERVER_A);

    await gateway.handleMatchEvent(client, event({ matchId: MATCH_2 }));
    matches[MATCH_2].server_id = SERVER_A;
    await gateway.handleMatchEvent(
      client,
      event({ matchId: MATCH_2, messageId: "msg-2" }),
    );

    expect(matchLookups()).toBe(2);
    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it("remembers the host for ten minutes", async () => {
    const { gateway, cache } = makeGateway();

    await gateway.handleMatchEvent(authedSocket(SERVER_A), event());

    expect(cache.put).toHaveBeenCalledWith(
      `match-events:last-host:${MATCH_1}`,
      SERVER_A,
      600,
    );
  });

  describe("legitimate edge flows", () => {
    function endMatch(matches: Record<string, MatchRow>, status = "Finished") {
      matches[MATCH_1].server_id = null;
      matches[MATCH_1].status = status;
    }

    it("moves with the match: the old server is refused and the new one accepted once the binding expires", async () => {
      const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      const { gateway, matches, processor } = makeGateway();
      const oldServer = authedSocket(SERVER_A);

      await gateway.handleMatchEvent(oldServer, event({ messageId: "m1" }));
      expect(processor.process).toHaveBeenCalledTimes(1);

      matches[MATCH_1].server_id = SERVER_B;
      now.mockReturnValue(1_010_000);

      await gateway.handleMatchEvent(oldServer, event({ messageId: "m2" }));
      expect(processor.process).toHaveBeenCalledTimes(1);

      await gateway.handleMatchEvent(
        authedSocket(SERVER_B),
        event({ messageId: "m3" }),
      );
      expect(processor.process).toHaveBeenCalledTimes(2);
    });

    it("re-checks on a fresh connection after a reconnect", async () => {
      const { gateway, matches, processor, matchLookups } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m1" }),
      );

      matches[MATCH_1].server_id = SERVER_B;

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m2" }),
      );

      expect(matchLookups()).toBe(2);
      expect(processor.process).toHaveBeenCalledTimes(1);
    });

    it.each(["Finished", "Surrendered", "Canceled", "Forfeit", "Tie"])(
      "lets the last host flush mapStatus, chat and disconnects after the match ends (%s)",
      async (status) => {
        const { gateway, matches, processor } = makeGateway();

        await gateway.handleMatchEvent(
          authedSocket(SERVER_A),
          event({ messageId: "m1" }),
        );

        endMatch(matches, status);

        const lateHost = authedSocket(SERVER_A);
        await gateway.handleMatchEvent(
          lateHost,
          event({ messageId: "m2", name: "mapStatus" }),
        );
        await gateway.handleMatchEvent(
          lateHost,
          event({ messageId: "m3", name: "chat" }),
        );
        await gateway.handleMatchEvent(
          authedSocket(SERVER_A),
          event({ messageId: "m4", name: "player-disconnected" }),
        );

        expect(processor.process).toHaveBeenCalledTimes(4);
      },
    );

    it.each(["surrender", "score", "restoreRound", "techTimeout", "kill"])(
      "refuses %s from the last host once the match has ended",
      async (name) => {
        const { gateway, matches, processor } = makeGateway();

        await gateway.handleMatchEvent(
          authedSocket(SERVER_A),
          event({ messageId: "m1" }),
        );

        endMatch(matches);

        await gateway.handleMatchEvent(
          authedSocket(SERVER_A),
          event({ messageId: "m2", name }),
        );

        expect(processor.process).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps refusing result changes on a connection whose ended binding is cached", async () => {
      const { gateway, matches, processor, matchLookups } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m1" }),
      );

      endMatch(matches);

      const lateHost = authedSocket(SERVER_A);
      await gateway.handleMatchEvent(
        lateHost,
        event({ messageId: "m2", name: "chat" }),
      );
      await gateway.handleMatchEvent(
        lateHost,
        event({ messageId: "m3", name: "surrender" }),
      );

      expect(matchLookups()).toBe(2);
      expect(processor.process).toHaveBeenCalledTimes(2);
    });

    it("keeps an ended match closed to every other server", async () => {
      const { gateway, matches, processor } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m1" }),
      );

      endMatch(matches);

      await gateway.handleMatchEvent(
        authedSocket(SERVER_B),
        event({ messageId: "m2", name: "chat" }),
      );

      expect(processor.process).toHaveBeenCalledTimes(1);
    });

    it("refuses an ended match nobody was seen hosting", async () => {
      const { gateway, processor } = makeGateway({
        matches: {
          [MATCH_1]: {
            server_id: null,
            status: "Finished",
            match_maps: [{ id: MAP_1 }],
          },
        },
      });

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ name: "chat" }),
      );

      expect(processor.process).not.toHaveBeenCalled();
    });

    it("refuses the previous host once the match moved and then ended", async () => {
      const { gateway, matches, processor } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m1" }),
      );

      matches[MATCH_1].server_id = SERVER_B;
      await gateway.handleMatchEvent(
        authedSocket(SERVER_B),
        event({ messageId: "m2" }),
      );
      expect(processor.process).toHaveBeenCalledTimes(2);

      endMatch(matches);

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m3", name: "chat" }),
      );
      expect(processor.process).toHaveBeenCalledTimes(2);

      await gateway.handleMatchEvent(
        authedSocket(SERVER_B),
        event({ messageId: "m4", name: "chat" }),
      );
      expect(processor.process).toHaveBeenCalledTimes(3);
    });

    it("learns the new host from a refused lookup even if it never posted before the match ended", async () => {
      const { gateway, matches, processor } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m1" }),
      );

      matches[MATCH_1].server_id = SERVER_B;
      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m2" }),
      );

      endMatch(matches, "Canceled");

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m3", name: "chat" }),
      );

      expect(processor.process).toHaveBeenCalledTimes(1);
    });

    it("refuses the previous host while the match waits for a new server", async () => {
      const { gateway, matches, processor } = makeGateway();

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m1" }),
      );

      endMatch(matches, "WaitingForServer");

      await gateway.handleMatchEvent(
        authedSocket(SERVER_A),
        event({ messageId: "m2", name: "chat" }),
      );

      expect(processor.process).toHaveBeenCalledTimes(1);
    });
  });
});
