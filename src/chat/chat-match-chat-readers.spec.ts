import { ChatGateway } from "./chat.gateway";
import { ChatService } from "./chat.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { fakeRoomPage, isRoomPageScript } from "./testing/fakeRoomPage";
import { rolesAtOrAbove } from "../utilities/isRoleAbove";

describe("ChatService moderators reading a match's Match Chat", () => {
  const MATCH = "33333333-3333-4333-8333-333333333333";
  const LINEUP_1 = "44444444-4444-4444-8444-444444444441";
  const LINEUP_2 = "44444444-4444-4444-8444-444444444442";
  const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

  const PLAYER = "76561190000000101";
  const OPPONENT = "76561190000000102";
  const COACH = "76561190000000103";
  const MODERATOR = "76561190000000201";
  const ADMIN = "76561190000000202";
  const OUTSIDER = "76561190000000301";

  const ROOM = `chat:match:${MATCH}`;
  const MESSAGES = `chat_match_${MATCH}`;

  let status: string;
  let roles: Record<string, string>;
  let lineups: Record<string, { players: string[]; coach: string | null }>;
  let hashes: Record<string, Record<string, string>>;

  const organizerByRole = (steamId: string) =>
    rolesAtOrAbove("match_organizer").includes(roles[steamId] as any);

  const hasura = {
    getPlayerRole: jest.fn(async (steamId: string) => roles[String(steamId)]),
    query: jest.fn(async (query: any, steamId?: string) => {
      if (query.matches_by_pk?.server) {
        return {
          matches_by_pk: {
            status,
            server: { id: "server-1", plugin_runtime: "counterstrikesharp" },
          },
        };
      }

      if (query.matches_by_pk?.lineup_1) {
        const [first, second] = [LINEUP_1, LINEUP_2].map((id) => ({
          name: id,
          coach_steam_id: lineups[id].coach,
          lineup_players: lineups[id].players.map((steam_id) => ({
            steam_id,
          })),
        }));

        return {
          matches_by_pk: {
            organizer_steam_id: null,
            lineup_1: first,
            lineup_2: second,
          },
        };
      }

      if (query.matches_by_pk) {
        if (query.matches_by_pk.__args.id !== MATCH) {
          return { matches_by_pk: null };
        }

        const viewer = String(steamId);

        return {
          matches_by_pk: {
            is_in_lineup: Object.values(lineups).some(({ players }) =>
              players.includes(viewer),
            ),
            is_coach: Object.values(lineups).some(
              ({ coach }) => coach === viewer,
            ),
            // NULL, not false, for a match nobody organizes.
            is_organizer: organizerByRole(viewer) ? true : null,
            status,
          },
        };
      }

      if (query.match_lineups_by_pk) {
        const id = query.match_lineups_by_pk.__args.id;

        return {
          match_lineups_by_pk: lineups[id] && {
            match_id: MATCH,
            coach_steam_id: lineups[id].coach,
            is_on_lineup: lineups[id].players.includes(String(steamId)),
            lineup_players: lineups[id].players.map((steam_id) => ({
              steam_id,
            })),
          },
        };
      }

      if (query.players_by_pk) {
        const id = String(query.players_by_pk.__args.steam_id);

        return {
          players_by_pk: {
            steam_id: id,
            name: `P${id.slice(-3)}`,
            role: roles[id],
          },
        };
      }

      return {};
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
    scard: jest.fn().mockResolvedValue(1),
    sendCommand: jest.fn(),
    eval: jest.fn(async (script: string, _keys: number, ...args: any[]) => {
      if (isRoomPageScript(script)) {
        return fakeRoomPage(hashes[args[0]], hashes[args[2]], args[6]);
      }

      if (script.includes("INCR")) {
        return 1;
      }

      if (script.includes("cjson")) {
        return JSON.stringify({ [args[4]]: [args[5]] });
      }

      return [1, 1];
    }),
  };

  const postgres = {
    query: jest.fn(async (sql: string) =>
      sql.includes("public.is_gagged") ? [{ gagged: false }] : [],
    ),
  };

  const rcon = { send: jest.fn() };

  const push = {
    sendChatMessage: jest.fn(),
    retractChatMessage: jest.fn().mockResolvedValue(undefined),
  };

  let service: ChatService;

  const user = (steamId: string) =>
    ({
      steam_id: steamId,
      name: `P${steamId.slice(-3)}`,
      role: roles[steamId],
    }) as any;

  const client = (steamId: string) =>
    ({
      id: `client-${steamId}`,
      user: user(steamId),
      send: jest.fn(),
      on: jest.fn(),
    }) as any;

  const sentTo = (socket: { send: jest.Mock }) =>
    socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

  const seat = (steamId: string, joinedAs = roles[steamId]) => {
    hashes[ROOM] = {
      ...hashes[ROOM],
      [steamId]: JSON.stringify({ user: { ...user(steamId), role: joinedAs } }),
    };
  };

  const storeLine = (author: string, sentAt = new Date()) => {
    hashes[MESSAGES] = {
      ...hashes[MESSAGES],
      [MESSAGE_ID]: JSON.stringify({
        id: MESSAGE_ID,
        message: "can we get a tech pause after this round",
        timestamp: sentAt.toISOString(),
        source: "web",
        from: { role: roles[author], name: "Someone", steam_id: author },
      }),
    };
  };

  const deliveredTo = (event = "chat") =>
    redis.publish.mock.calls
      .map(([, payload]) => JSON.parse(payload))
      .filter(
        (published) => published.event === `lobby:match:${MATCH}:${event}`,
      )
      .map(({ steamId }) => steamId);

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    status = "Live";
    roles = {
      [PLAYER]: "user",
      [OPPONENT]: "verified_user",
      [COACH]: "user",
      [MODERATOR]: "moderator",
      [ADMIN]: "administrator",
      [OUTSIDER]: "user",
    };
    lineups = {
      [LINEUP_1]: { players: [PLAYER], coach: COACH },
      [LINEUP_2]: { players: [OPPONENT], coach: null },
    };
    hashes = {};

    service = new ChatService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { connect: jest.fn(async () => rcon) } as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      push as any,
      {
        blockedBy: jest.fn(async () => new Set()),
        blockedAmong: jest.fn(async () => new Map()),
      } as any,
      {
        claim: jest.fn(),
        expireMessage: jest.fn(async () => {}),
        markDeleted: jest.fn(async () => {}),
      } as any,
      { enabled: jest.fn(async () => true) } as any,
    );
  });

  const join = async (
    steamId: string,
    type = ChatLobbyType.Match,
    id = MATCH,
  ) => {
    const socket = client(steamId);

    await service.joinMatchLobby(socket, type, id);

    return socket;
  };

  const history = (socket: { send: jest.Mock }) =>
    sentTo(socket).find(({ event }) => event.endsWith(":messages"))?.data;

  describe("reading", () => {
    it.each(["WaitingForCheckIn", "Veto", "WaitingForServer", "Live"])(
      "lets a moderator read it, read only, while the match is %s",
      async (matchStatus) => {
        status = matchStatus;
        storeLine(PLAYER);

        const socket = await join(MODERATOR);

        expect(history(socket)).toMatchObject({
          id: MATCH,
          readOnly: true,
          messages: [expect.objectContaining({ id: MESSAGE_ID })],
        });
        expect(hashes[ROOM]?.[MODERATOR]).toBeDefined();
      },
    );

    it.each(["PickingPlayers", "Scheduled", "Finished", "Canceled", "Forfeit"])(
      "keeps a moderator out while the match is %s",
      async (matchStatus) => {
        status = matchStatus;

        const socket = await join(MODERATOR);

        expect(history(socket)).toBeUndefined();
        expect(hashes[ROOM]?.[MODERATOR]).toBeUndefined();
      },
    );

    it.each(["user", "verified_user", "streamer"])(
      "still keeps out a %s who has no part in the match",
      async (role) => {
        roles[OUTSIDER] = role;

        const socket = await join(OUTSIDER);

        expect(history(socket)).toBeUndefined();
        expect(hashes[ROOM]?.[OUTSIDER]).toBeUndefined();
      },
    );

    it("judges the role held now, not the one the socket signed in with", async () => {
      const socket = client(MODERATOR);
      socket.user.role = "moderator";
      roles[MODERATOR] = "user";

      await service.joinMatchLobby(socket, ChatLobbyType.Match, MATCH);

      expect(history(socket)).toBeUndefined();
    });

    it.each([PLAYER, COACH, ADMIN])(
      "leaves the match's own people able to write (%s)",
      async (steamId) => {
        const socket = await join(steamId);

        expect(history(socket)).toMatchObject({ id: MATCH });
        expect(history(socket)).not.toHaveProperty("readOnly");
      },
    );

    it("lets a moderator on a lineup write like any player", async () => {
      lineups[LINEUP_1].players.push(MODERATOR);

      const socket = await join(MODERATOR);

      expect(history(socket)).toMatchObject({ id: MATCH });
      expect(history(socket)).not.toHaveProperty("readOnly");
    });

    it("lets a moderator page back through it", async () => {
      seat(MODERATOR);

      await expect(
        service.olderMessages(
          client(MODERATOR),
          ChatLobbyType.Match,
          MATCH,
          `${new Date().toISOString()}|${MESSAGE_ID}`,
        ),
      ).resolves.toMatchObject({ messages: [] });
    });

    it.each([LINEUP_1, LINEUP_2])(
      "keeps either team's own chat closed to a moderator (%s)",
      async (lineupId) => {
        const id = `${MATCH}:${lineupId}`;

        const socket = await join(MODERATOR, ChatLobbyType.MatchTeam, id);

        expect(history(socket)).toBeUndefined();
        expect(hashes[`chat:match_team:${id}`]?.[MODERATOR]).toBeUndefined();
      },
    );
  });

  describe("writing", () => {
    beforeEach(() => {
      seat(MODERATOR);
      seat(PLAYER);
    });

    it("refuses a moderator's message, so nothing reaches the room or the game server", async () => {
      const gateway = new ChatGateway(service);
      const socket = client(MODERATOR);

      await gateway.lobby(
        {
          id: MATCH,
          type: ChatLobbyType.Match,
          message: "please keep it civil",
          requestId: "r-1",
        },
        socket,
      );

      expect(sentTo(socket)).toEqual([
        {
          event: "chat:error",
          data: {
            code: ChatErrorCode.NotAllowed,
            action: "send",
            requestId: "r-1",
          },
        },
      ]);
      expect(hashes[MESSAGES]).toBeUndefined();
      expect(redis.publish).not.toHaveBeenCalled();
      expect(rcon.send).not.toHaveBeenCalled();
      expect(push.sendChatMessage).not.toHaveBeenCalled();
    });

    it("still relays a player's message into the game", async () => {
      const gateway = new ChatGateway(service);

      await gateway.lobby(
        { id: MATCH, type: ChatLobbyType.Match, message: "gg" },
        client(PLAYER),
      );

      expect(hashes[MESSAGES]).toBeDefined();
      expect(rcon.send).toHaveBeenCalledWith(`css_web_chat "P101: gg" 0`);
    });

    it("refuses a moderator's GIF", async () => {
      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          MATCH,
          user(MODERATOR),
          "",
          false,
          "web",
          { gif: { id: "xT9IgDEI1iZyb2wqo8", width: 200, height: 200 } },
        ),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });
    });

    it("refuses a moderator's upload", async () => {
      await expect(
        service.attachmentRefusal(ChatLobbyType.Match, MATCH, user(MODERATOR)),
      ).resolves.toBe(ChatErrorCode.NotAllowed);
    });

    it("refuses a moderator's reaction, and lets a player's through", async () => {
      storeLine(PLAYER);

      await expect(
        service.toggleReaction(
          ChatLobbyType.Match,
          MATCH,
          MESSAGE_ID,
          "heart",
          user(MODERATOR),
        ),
      ).resolves.toEqual({ toggled: false, code: ChatErrorCode.NotAllowed });

      expect(
        redis.eval.mock.calls.filter(([script]) => script.includes("cjson")),
      ).toHaveLength(0);

      await expect(
        service.toggleReaction(
          ChatLobbyType.Match,
          MATCH,
          MESSAGE_ID,
          "heart",
          user(PLAYER),
        ),
      ).resolves.toMatchObject({ toggled: true });
    });

    it("refuses an edit to a line the moderator sent while they were playing", async () => {
      storeLine(MODERATOR);

      await expect(
        service.editMessage(
          ChatLobbyType.Match,
          MATCH,
          MESSAGE_ID,
          user(MODERATOR),
          "edited",
        ),
      ).resolves.toEqual({ edited: false, code: ChatErrorCode.NotAllowed });
    });
  });

  describe("moderating", () => {
    it("lets a moderator delete a player's line, kept as evidence", async () => {
      seat(PLAYER);
      storeLine(PLAYER, new Date("2025-01-01T00:00:00.000Z"));

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          MATCH,
          MESSAGE_ID,
          user(MODERATOR),
        ),
      ).resolves.toEqual({ deleted: true });

      expect(hashes[MESSAGES][MESSAGE_ID]).toBeUndefined();
      expect(
        postgres.query.mock.calls.some(([sql]) =>
          sql.includes("INSERT INTO public.chat_message_deletions"),
        ),
      ).toBe(true);

      await flush();

      expect(deliveredTo("deleted")).toEqual([PLAYER]);
    });

    it("still refuses a delete once the match is over", async () => {
      status = "Finished";
      storeLine(PLAYER, new Date("2025-01-01T00:00:00.000Z"));

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          MATCH,
          MESSAGE_ID,
          user(MODERATOR),
        ),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotAllowed });
    });
  });

  describe("delivery", () => {
    beforeEach(() => {
      seat(PLAYER);
      seat(OPPONENT);
      seat(MODERATOR);
    });

    const deliver = () =>
      service.to(ChatLobbyType.Match, MATCH, "chat", {}, PLAYER);

    it("reaches a moderator reading the room", async () => {
      await deliver();

      expect(deliveredTo()).toEqual([PLAYER, OPPONENT, MODERATOR]);
    });

    it("stops reaching a moderator demoted while reading, and never forgets them", async () => {
      roles[MODERATOR] = "user";

      await deliver();

      expect(deliveredTo()).toEqual([PLAYER, OPPONENT]);
      expect(hashes[ROOM][MODERATOR]).toBeDefined();

      roles[MODERATOR] = "moderator";
      redis.publish.mockClear();

      await deliver();

      expect(deliveredTo()).toEqual([PLAYER, OPPONENT, MODERATOR]);
    });

    it("keeps reaching a demoted administrator who is on a lineup", async () => {
      lineups[LINEUP_2].players.push(ADMIN);
      seat(ADMIN);
      roles[ADMIN] = "user";

      await deliver();

      expect(deliveredTo()).toEqual([PLAYER, OPPONENT, MODERATOR, ADMIN]);
    });

    it("keeps reaching a demoted moderator who is in the game", async () => {
      roles[MODERATOR] = "user";
      hashes[ROOM][MODERATOR] = JSON.stringify({
        user: { ...user(MODERATOR), role: "moderator" },
        inGame: true,
      });

      await deliver();

      expect(deliveredTo()).toEqual([PLAYER, OPPONENT, MODERATOR]);
    });

    it("drops someone whose role cannot be read", async () => {
      hasura.getPlayerRole.mockImplementation(async (steamId: string) => {
        if (steamId === MODERATOR) {
          throw new Error("connection reset");
        }

        return roles[steamId];
      });

      await deliver();

      expect(deliveredTo()).toEqual([PLAYER, OPPONENT]);

      hasura.getPlayerRole.mockImplementation(
        async (steamId: string) => roles[String(steamId)],
      );
    });

    it("never looks up the role of anyone who joined as a player", async () => {
      await deliver();

      expect(
        hasura.getPlayerRole.mock.calls.map(([steamId]) => steamId),
      ).toEqual([MODERATOR]);
    });
  });
});
