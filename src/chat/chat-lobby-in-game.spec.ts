import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { fakeRoomPage, isRoomPageScript } from "./testing/fakeRoomPage";

describe("ChatService match lobby while a player is in the game server", () => {
  const MATCH = "33333333-3333-4333-8333-333333333333";
  const PLAYER = "76561190000000101";
  const TEAMMATE = "76561190000000102";
  const ORGANIZER = "76561190000000201";
  const LINEUP = [PLAYER, TEAMMATE];
  const ROOM = `chat:match:${MATCH}`;

  let hashes: Record<string, Record<string, string>>;
  let sets: Record<string, Set<string>>;
  let connected: Set<string>;
  let status: string;
  let lineupCheckFails: boolean;
  let beforeSessionRemoved: (() => Promise<void>) | null;
  let tabs: number;

  const hasura = {
    getPlayerRole: jest.fn(async () => "user"),
    query: jest.fn(async (query: any) => {
      const response: Record<string, unknown> = {};

      if (query.players_by_pk) {
        const steamId = String(query.players_by_pk.__args.steam_id);

        response.players_by_pk = {
          steam_id: steamId,
          name: `P${steamId.slice(-3)}`,
          role: "user",
        };
      }

      if (query.matches_by_pk) {
        response.matches_by_pk = {
          is_in_lineup: true,
          is_coach: false,
          is_organizer: null,
          status,
          source: null,
        };
      }

      if (query.match_lineup_players) {
        if (lineupCheckFails) {
          throw new Error("hasura unavailable");
        }

        const { where } = query.match_lineup_players.__args;
        const steamId = String(where.steam_id._eq);
        const inServer =
          where.is_connected._eq === true &&
          where.lineup.match_id._eq === MATCH &&
          !where.lineup.match.status._nin.includes(status) &&
          LINEUP.includes(steamId) &&
          connected.has(steamId);

        response.match_lineup_players = inServer ? [{ id: "mlp" }] : [];
      }

      return response;
    }),
  };

  const redis = {
    hget: jest.fn(
      async (key: string, field: string) => hashes[key]?.[field] ?? null,
    ),
    hset: jest.fn(async (key: string, field: string, value: string) => {
      hashes[key] = { ...hashes[key], [field]: value };
      return 1;
    }),
    hgetall: jest.fn(async (key: string) => ({ ...hashes[key] })),
    hdel: jest.fn(async (key: string, field: string) => {
      delete hashes[key]?.[field];
      return 1;
    }),
    expire: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    zrem: jest.fn().mockResolvedValue(1),
    publish: jest.fn(),
    scard: jest.fn(async (key: string) => sets[key]?.size ?? 0),
    sendCommand: jest.fn(),
    eval: jest.fn(async (script: string, _keys: number, ...args: any[]) => {
      if (isRoomPageScript(script)) {
        return fakeRoomPage(hashes[args[0]], hashes[args[2]], args[6]);
      }

      if (script.includes("'SADD'")) {
        const sessions = (sets[args[0]] ??= new Set());
        const added = sessions.has(args[1]) ? 0 : 1;
        sessions.add(args[1]);
        return [added, sessions.size];
      }

      if (script.includes("'SREM'")) {
        if (beforeSessionRemoved) {
          const hook = beforeSessionRemoved;
          beforeSessionRemoved = null;
          await hook();
        }

        const sessions = sets[args[0]] ?? new Set();
        const removed = sessions.delete(args[1]) ? 1 : 0;
        return [removed, sessions.size];
      }

      return [1, 1];
    }),
  };

  let service: ChatService;

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const openTab = async (steamId: string) => {
    tabs++;
    const socket = {
      id: `tab-${tabs}`,
      user: { steam_id: steamId, name: `P${steamId.slice(-3)}`, role: "user" },
      send: jest.fn(),
      on: jest.fn(),
    } as any;

    await service.joinMatchLobby(socket, ChatLobbyType.Match, MATCH);
    await flush();

    return socket;
  };

  const closeTab = async (socket: any) => {
    await service.removeFromLobby(ChatLobbyType.Match, MATCH, socket);
    await flush();
  };

  const connectToServer = async (steamId: string) => {
    if (LINEUP.includes(steamId)) {
      connected.add(steamId);
    }
    await service.joinLobbyViaGame(MATCH, steamId);
    await flush();
  };

  const disconnectFromServer = async (steamId: string) => {
    connected.delete(steamId);
    await service.leaveLobbyViaGame(MATCH, steamId);
    await flush();
  };

  const presence = (steamId: string) => {
    const entry = hashes[ROOM]?.[steamId];

    return entry ? { inGame: JSON.parse(entry).inGame ?? false } : null;
  };

  const seenBy = (viewer: string, about: string) => {
    return redis.publish.mock.calls
      .map(([, payload]) => JSON.parse(payload))
      .filter(({ steamId, event, data }) => {
        return (
          steamId === viewer &&
          [`lobby:match:${MATCH}:joined`, `lobby:match:${MATCH}:left`].includes(
            event,
          ) &&
          data.user.steam_id === about
        );
      })
      .map(({ event, data }) => ({
        event: event.split(":").pop(),
        inGame: data.user.inGame ?? false,
      }));
  };

  const listedFor = (socket: { send: jest.Mock }, steamId: string) => {
    const list = socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find(({ event }) => event === `lobby:match:${MATCH}:list`);

    return list?.data.lobby.find(
      (user: { steam_id: string }) => user.steam_id === steamId,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    hashes = {};
    sets = {};
    connected = new Set();
    status = "Live";
    lineupCheckFails = false;
    beforeSessionRemoved = null;
    tabs = 0;

    service = new ChatService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { connect: jest.fn() } as any,
      hasura as any,
      { query: jest.fn(async (): Promise<Array<never>> => []) } as any,
      { getConnection: () => redis } as any,
      { sendChatMessage: jest.fn() } as any,
      {
        blockedBy: jest.fn(async () => new Set()),
        blockedAmong: jest.fn(async () => new Map()),
      } as any,
      {} as any,
      { enabled: jest.fn(async () => true) } as any,
    );
  });

  it("keeps a player in game when they close their last tab", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    redis.publish.mockClear();

    await closeTab(tab);

    expect(presence(PLAYER)).toEqual({ inGame: true });
    expect(seenBy(TEAMMATE, PLAYER)).toEqual([]);

    const fresh = await openTab(TEAMMATE);
    expect(listedFor(fresh, PLAYER)).toMatchObject({ inGame: true });
  });

  it("still shows them in game when they open the match page again", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    await closeTab(tab);
    redis.publish.mockClear();

    await openTab(PLAYER);

    expect(seenBy(TEAMMATE, PLAYER)).toEqual([
      { event: "joined", inGame: true },
    ]);
  });

  it("drops them once they leave the server after closing the tab", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    await closeTab(tab);
    redis.publish.mockClear();

    await disconnectFromServer(PLAYER);

    expect(presence(PLAYER)).toBeNull();
    expect(seenBy(TEAMMATE, PLAYER)).toEqual([
      { event: "left", inGame: false },
    ]);
  });

  it("drops them once they close the tab after leaving the server", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    await disconnectFromServer(PLAYER);

    expect(presence(PLAYER)).toEqual({ inGame: false });
    redis.publish.mockClear();

    await closeTab(tab);

    expect(presence(PLAYER)).toBeNull();
    expect(seenBy(TEAMMATE, PLAYER)).toEqual([
      { event: "left", inGame: false },
    ]);
  });

  it("drops them when they leave the server while the tab is closing", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    beforeSessionRemoved = () => disconnectFromServer(PLAYER);

    await closeTab(tab);

    expect(presence(PLAYER)).toBeNull();
  });

  it("drops an in-game player who is not on a lineup when they close their tab", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(ORGANIZER);
    await connectToServer(ORGANIZER);
    redis.publish.mockClear();

    await closeTab(tab);

    expect(presence(ORGANIZER)).toBeNull();
    expect(seenBy(TEAMMATE, ORGANIZER)).toEqual([
      { event: "left", inGame: true },
    ]);
  });

  it("drops a lineup player the server reports gone, even if the lobby still says in game", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    await disconnectFromServer(PLAYER);
    hashes[ROOM][PLAYER] = JSON.stringify({
      ...JSON.parse(hashes[ROOM][PLAYER]),
      inGame: true,
    });

    await closeTab(tab);

    expect(presence(PLAYER)).toBeNull();
  });

  it("drops a lineup player once the match is over", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    status = "Finished";

    await closeTab(tab);

    expect(presence(PLAYER)).toBeNull();
  });

  it("drops a player who is not in the server when they close their last tab", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    redis.publish.mockClear();

    await closeTab(tab);

    expect(presence(PLAYER)).toBeNull();
    expect(seenBy(TEAMMATE, PLAYER)).toEqual([
      { event: "left", inGame: false },
    ]);
  });

  it("keeps a player in game who closes one of two tabs", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await openTab(PLAYER);
    await connectToServer(PLAYER);

    await closeTab(tab);

    expect(presence(PLAYER)).toEqual({ inGame: true });
  });

  it("drops the entry as before when the lineup check fails", async () => {
    await openTab(TEAMMATE);
    const tab = await openTab(PLAYER);
    await connectToServer(PLAYER);
    lineupCheckFails = true;
    redis.publish.mockClear();

    await expect(closeTab(tab)).resolves.toBeUndefined();

    expect(presence(PLAYER)).toBeNull();
    expect(seenBy(TEAMMATE, PLAYER)).toEqual([{ event: "left", inGame: true }]);
  });

  describe("once the match ends", () => {
    it("drops entries with no tab open", async () => {
      await openTab(TEAMMATE);
      const tab = await openTab(PLAYER);
      await connectToServer(PLAYER);
      await closeTab(tab);
      redis.publish.mockClear();

      await service.endMatchLobby(MATCH);
      await flush();

      expect(presence(PLAYER)).toBeNull();
      expect(seenBy(TEAMMATE, PLAYER)).toEqual([
        { event: "left", inGame: false },
      ]);
    });

    it("keeps entries with a tab open, no longer in game", async () => {
      await openTab(PLAYER);
      await openTab(TEAMMATE);
      await connectToServer(TEAMMATE);
      redis.publish.mockClear();

      await service.endMatchLobby(MATCH);
      await flush();

      expect(presence(TEAMMATE)).toEqual({ inGame: false });
      expect(seenBy(PLAYER, TEAMMATE)).toEqual([
        { event: "joined", inGame: false },
      ]);
    });

    it("does not mark a player in game who connects after it ended", async () => {
      await openTab(TEAMMATE);
      await openTab(PLAYER);
      status = "Finished";
      redis.publish.mockClear();

      await connectToServer(PLAYER);
      await connectToServer(ORGANIZER);

      expect(presence(PLAYER)).toEqual({ inGame: false });
      expect(presence(ORGANIZER)).toBeNull();
      expect(seenBy(TEAMMATE, PLAYER)).toEqual([]);
    });

    it("leaves entries with a tab open that were not in game alone", async () => {
      await openTab(PLAYER);
      await openTab(TEAMMATE);
      redis.publish.mockClear();

      await service.endMatchLobby(MATCH);
      await flush();

      expect(presence(TEAMMATE)).toEqual({ inGame: false });
      expect(seenBy(PLAYER, TEAMMATE)).toEqual([]);
    });
  });
});
