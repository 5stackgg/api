import { ChatService } from "./chat.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { directRoomId } from "./utilities/directRoomId";
import { HasuraService } from "../hasura/hasura.service";

const ME = "76561198000000001";
const FRIEND = "76561198000000002";
const STRANGER = "76561198000000003";

describe("ChatService direct messages", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const redis = {
    hset: jest.fn(),
    hget: jest.fn().mockResolvedValue(null),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
    zadd: jest.fn(),
    zrevrange: jest.fn().mockResolvedValue([]),
    publish: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    scard: jest.fn().mockResolvedValue(1),
    sendCommand: jest.fn(),
    eval: jest.fn().mockResolvedValue([1, 1]),
  };

  const rcon = { connect: jest.fn(), send: jest.fn() };

  let service: ChatService;
  let acceptedFriendships: Array<[string, string]>;
  let role: string;
  let queries: Array<{ sql: string; bindings: any[] }>;
  const postgres = {
    query: jest.fn(async (sql: string, bindings: any[]): Promise<any[]> => {
      queries.push({ sql, bindings });
      return [];
    }),
  };

  const client = (steamId: string) =>
    ({
      id: "client-1",
      user: { steam_id: steamId, name: "Someone", role },
      send: jest.fn(),
      on: jest.fn(),
    }) as any;

  // Which matches this player belongs to, by id.
  let myMatches: string[];
  // The one tournament the fake knows about, and who is attached to it.
  let tournament: {
    organizers: string[];
    teamOwners: string[];
    roster: string[];
    freeAgents: Array<{ steam_id: string; status: string }>;
  };
  // Who the organizers' role gate admits.
  let staff: string[];

  // Answers the access query the way the database would, so the assertions are
  // about who gets in rather than about the shape of the query.
  const tournamentAdmits = (where: any) =>
    (where._or ?? []).some((branch: any) => {
      if (branch.is_organizer) {
        return tournament.organizers.includes(String(steamIdIn(branch)));
      }

      if (branch.teams) {
        return branch.teams._or.some((teamBranch: any) => {
          const steamId = String(steamIdIn(teamBranch));
          return teamBranch.owner_steam_id
            ? tournament.teamOwners.includes(steamId)
            : tournament.roster.includes(steamId);
        });
      }

      if (branch.free_agents) {
        const steamId = String(branch.free_agents.player_steam_id._eq);
        const statuses = branch.free_agents.status?._in ?? [];

        return tournament.freeAgents.some(
          (freeAgent) =>
            freeAgent.steam_id === steamId &&
            statuses.includes(freeAgent.status),
        );
      }

      return false;
    });

  // the steam id buried anywhere in one branch of the _or
  const steamIdIn = (branch: any): string | undefined => {
    if (typeof branch !== "object" || branch === null) {
      return undefined;
    }

    for (const [key, value] of Object.entries<any>(branch)) {
      if (key.endsWith("steam_id") && value?._eq !== undefined) {
        return String(value._eq);
      }

      const nested = Array.isArray(value)
        ? value.map(steamIdIn).find(Boolean)
        : steamIdIn(value);

      if (nested) {
        return nested;
      }
    }

    return undefined;
  };

  const hasuraService = {
    query: jest.fn(async (query: any) => {
      if (query.tournaments) {
        return {
          tournaments: tournamentAdmits(query.tournaments.__args.where)
            ? [{ id: "t-1" }]
            : [],
        };
      }

      if (query.tournaments_by_pk) {
        return {
          tournaments_by_pk: {
            organizer_steam_id: tournament.organizers[0],
            organizers: tournament.organizers
              .slice(1)
              .map((steam_id) => ({ steam_id })),
            teams: [
              {
                owner_steam_id: tournament.teamOwners[0],
                roster: tournament.roster.map((player_steam_id) => ({
                  player_steam_id,
                })),
              },
            ],
            free_agents: tournament.freeAgents
              .filter((freeAgent) =>
                (
                  query.tournaments_by_pk.free_agents?.__args?.where?.status
                    ?._in ?? []
                ).includes(freeAgent.status),
              )
              .map((freeAgent) => ({
                player_steam_id: freeAgent.steam_id,
                status: freeAgent.status,
              })),
          },
        };
      }

      if (query.matches_by_pk?.server) {
        return {
          matches_by_pk: {
            status: "Live",
            server: { id: "server-1", plugin_runtime: "counterstrikesharp" },
          },
        };
      }

      if (query.matches_by_pk) {
        return myMatches.includes(query.matches_by_pk.__args.id)
          ? {
              matches_by_pk: {
                is_coach: false,
                is_organizer: false,
                is_in_lineup: true,
              },
            }
          : {};
      }

      if (query.players) {
        return { players: staff.map((steam_id) => ({ steam_id })) };
      }

      if (query.players_by_pk) {
        return {
          players_by_pk: {
            steam_id: query.players_by_pk.__args.steam_id,
            name: "Someone",
            role,
          },
        };
      }

      if (query.friends) {
        const where = query.friends.__args.where;
        const [first, second] = where._or;
        const pair = [
          first.player_steam_id._eq,
          first.other_player_steam_id._eq,
        ].map(String);

        const matches = acceptedFriendships.some(
          ([a, b]) =>
            (a === pair[0] && b === pair[1]) || (a === pair[1] && b === pair[0]),
        );

        expect(where.status._eq).toBe("Accepted");
        expect(second.player_steam_id._eq).toBe(first.other_player_steam_id._eq);

        return { friends: matches ? [{ status: "Accepted" }] : [] };
      }

      return {};
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, so a test that seats someone in a
    // room would otherwise leave them seated for every test after it.
    redis.hget.mockResolvedValue(null);
    redis.get.mockResolvedValue(null);
    acceptedFriendships = [[ME, FRIEND]];
    myMatches = ["m-1"];
    tournament = {
      organizers: [STRANGER],
      teamOwners: [],
      roster: [],
      freeAgents: [],
    };
    staff = [];
    role = "user";
    queries = [];
    rcon.send.mockResolvedValue(undefined);
    rcon.connect.mockResolvedValue(rcon);

    service = new ChatService(
      logger as any,
      { connect: rcon.connect } as any,
      hasuraService as any,
      postgres as any,
      { getConnection: () => redis } as any,
      { notifyPlayers: jest.fn(), markConversationRead: jest.fn() } as any,
    );
  });

  // Registering a session is the point of no return in joinMatchLobby -- every
  // rejection path returns before it.
  const joined = () => redis.eval.mock.calls.length > 0;

  describe("joining", () => {
    it("lets accepted friends into their conversation", async () => {
      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(ME, FRIEND),
      );

      expect(joined()).toBe(true);
    });

    it("refuses a pair with no accepted friendship", async () => {
      // The room id is just a sorted pair of steam ids, so anyone can compute
      // one for anyone. The friendship is the only real gate.
      acceptedFriendships = [];

      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(ME, STRANGER),
      );

      expect(joined()).toBe(false);
    });

    it("refuses someone who is not a party to the conversation", async () => {
      acceptedFriendships = [[FRIEND, STRANGER]];

      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(FRIEND, STRANGER),
      );

      expect(joined()).toBe(false);
    });

    it("gives an administrator no way in", async () => {
      // Deliberately unlike Draft and Organizer, which do let organizers in --
      // those are group rooms, a DM is a private conversation.
      acceptedFriendships = [];
      role = "administrator";

      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(ME, STRANGER),
      );

      expect(joined()).toBe(false);
    });

    it("refuses a malformed room id", async () => {
      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        "not-a-room",
      );

      expect(joined()).toBe(false);
    });
  });

  describe("tournament chat", () => {
    const join = async (steamId: string) => {
      await service.joinMatchLobby(
        client(steamId),
        ChatLobbyType.Tournament,
        "t-1",
      );
      return joined();
    };

    it("lets a player on a tournament team roster in", async () => {
      tournament.roster = [ME];

      expect(await join(ME)).toBe(true);
    });

    it("lets a registered free agent in", async () => {
      // in a free-agent tournament nobody is on a roster until the draft, so
      // this is everyone who signed up
      tournament.freeAgents = [{ steam_id: ME, status: "registered" }];

      expect(await join(ME)).toBe(true);
    });

    it("lets a waitlisted free agent in", async () => {
      tournament.freeAgents = [{ steam_id: ME, status: "waitlisted" }];

      expect(await join(ME)).toBe(true);
    });

    it("keeps a withdrawn free agent out", async () => {
      tournament.freeAgents = [{ steam_id: ME, status: "withdrawn" }];

      expect(await join(ME)).toBe(false);
    });

    it("keeps an unrelated player out", async () => {
      expect(await join(ME)).toBe(false);
    });

    // the message write is the awaited step; the broadcast after it is
    // deliberately fire-and-forget
    const posted = () =>
      redis.hset.mock.calls.some(([key]) => key === "chat_tournament_t-1");

    it("stops a free agent who withdrew from posting", async () => {
      // the room's membership lives in redis for 24h, so leaving the pool has
      // to be re-checked when the message is sent, not only when joining
      redis.hget.mockResolvedValue(JSON.stringify({ steam_id: ME }));
      tournament.freeAgents = [{ steam_id: ME, status: "withdrawn" }];

      await service.sendMessageToChat(
        ChatLobbyType.Tournament,
        "t-1",
        { steam_id: ME, name: "Someone", role } as any,
        "still here",
      );

      expect(posted()).toBe(false);
    });

    it("lets a registered free agent post", async () => {
      redis.hget.mockResolvedValue(JSON.stringify({ steam_id: ME }));
      tournament.freeAgents = [{ steam_id: ME, status: "registered" }];

      await service.sendMessageToChat(
        ChatLobbyType.Tournament,
        "t-1",
        { steam_id: ME, name: "Someone", role } as any,
        "hello",
      );

      expect(posted()).toBe(true);
    });

    it("notifies free agents as well as rostered players", async () => {
      tournament.organizers = [STRANGER];
      tournament.teamOwners = [FRIEND];
      tournament.roster = [FRIEND];
      tournament.freeAgents = [
        { steam_id: ME, status: "registered" },
        { steam_id: "76561198000000004", status: "withdrawn" },
      ];

      const recipients = await service.getLobbyMemberSteamIds(
        ChatLobbyType.Tournament,
        "t-1",
      );

      expect(recipients).toContain(ME);
      expect(recipients).toContain(FRIEND);
      expect(recipients).toContain(STRANGER);
      expect(recipients).not.toContain("76561198000000004");
    });
  });

  // Match chat is relayed into the game server as an rcon command with the
  // message inlined in quotes, so what a player types has to be unable to
  // terminate that argument or that line.
  describe("relaying to the game server", () => {
    const relayed = async (message: string) => {
      await service.sendChatToServer("m-1", message);
      return rcon.send.mock.calls.at(-1)?.[0] as string;
    };

    it("sends the message as one quoted argument", async () => {
      expect(await relayed("nice shot")).toBe('css_web_chat "nice shot"');
    });

    it("flattens a multi line message onto one line", async () => {
      expect(await relayed("top\nbottom")).toBe('css_web_chat "top bottom"');
      expect(await relayed("top\r\nbottom")).toBe('css_web_chat "top bottom"');
    });

    it("strips quotes so the message cannot escape the argument", async () => {
      expect(await relayed('x" ; quit ; say "')).not.toContain('"x"');
      expect(await relayed('x" ; quit ; say "')).toBe(
        'css_web_chat "x ; quit ; say"',
      );
    });

    const argument = (command: string) =>
      command.slice('css_web_chat "'.length, -1);

    it("relays a line at the limit untouched", async () => {
      const line = "a".repeat(ChatService.RCON_MESSAGE_MAX_LENGTH);

      expect(argument(await relayed(line))).toBe(line);
    });

    it("cuts a longer line to the limit, ellipsis included", async () => {
      const relayedLine = argument(
        await relayed("a".repeat(ChatService.MAX_MESSAGE_LENGTH)),
      );

      expect(Array.from(relayedLine)).toHaveLength(
        ChatService.RCON_MESSAGE_MAX_LENGTH,
      );
      expect(relayedLine.endsWith("a…")).toBe(true);
    });

    it("never splits a character in two", async () => {
      const relayedLine = argument(await relayed("😀".repeat(300)));

      expect(Array.from(relayedLine)).toHaveLength(
        ChatService.RCON_MESSAGE_MAX_LENGTH,
      );
      expect(relayedLine).toBe(
        `${"😀".repeat(ChatService.RCON_MESSAGE_MAX_LENGTH - 1)}…`,
      );
    });
  });

  describe("message text", () => {
    it.each([
      ["a number", 42],
      ["null", null],
      ["undefined", undefined],
      ["an object", { message: "hi" }],
      ["an array", ["hi"]],
      ["empty", ""],
      ["only whitespace", " \n\t "],
    ])("refuses %s as invalid", (_, raw) => {
      expect(ChatService.messageText(raw)).toEqual({
        error: ChatErrorCode.Invalid,
      });
    });

    it("trims what it accepts", () => {
      expect(ChatService.messageText("  gg wp \n")).toEqual({
        text: "gg wp",
      });
    });

    it("accepts exactly the limit and refuses one more", () => {
      const limit = "a".repeat(ChatService.MAX_MESSAGE_LENGTH);

      expect(ChatService.messageText(limit)).toEqual({ text: limit });
      expect(ChatService.messageText(`${limit}a`)).toEqual({
        error: ChatErrorCode.TooLong,
      });
    });

    it("measures after trimming", () => {
      const limit = "a".repeat(ChatService.MAX_MESSAGE_LENGTH);

      expect(ChatService.messageText(`   ${limit}   `)).toEqual({
        text: limit,
      });
    });

    it("counts UTF-16 code units, as the browser does", () => {
      const half = ChatService.MAX_MESSAGE_LENGTH / 2;

      expect(ChatService.messageText("😀".repeat(half))).toEqual({
        text: "😀".repeat(half),
      });
      expect(ChatService.messageText("😀".repeat(half + 1))).toEqual({
        error: ChatErrorCode.TooLong,
      });
    });
  });

  describe("sending", () => {
    const player = (overrides: Record<string, unknown> = {}) =>
      ({
        steam_id: ME,
        name: "Someone",
        role: "user",
        avatar_url: "avatar",
        profile_url: "profile",
        ...overrides,
      }) as any;

    const seatIn = (steamId: string) =>
      redis.hget.mockResolvedValue(
        JSON.stringify({ user: { steam_id: steamId } }),
      );

    const stored = (key: string) =>
      redis.hset.mock.calls
        .filter(([hash]) => hash === key)
        .map(([, , value]) => JSON.parse(value));

    it("stamps a website message with its source and a string steam id", async () => {
      seatIn(ME);

      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          player(),
          "hello",
        ),
      ).resolves.toEqual({ accepted: true });

      const [message] = stored("chat_match_m-1");

      expect(message).toMatchObject({
        message: "hello",
        source: "web",
        from: { steam_id: ME, name: "Someone", role: "user" },
      });
      expect(typeof message.from.steam_id).toBe("string");
    });

    it("stamps a line from the game, and stores its steam id as a string", async () => {
      await service.sendMessageToChat(
        ChatLobbyType.Match,
        "m-1",
        player({ steam_id: BigInt(ME) }),
        "from the server",
        true,
        "game",
      );

      const [message] = stored("chat_match_m-1");

      expect(message.source).toBe("game");
      expect(message.from.steam_id).toBe(ME);
    });

    it("refuses a website message over the limit without storing it", async () => {
      seatIn(ME);

      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          player(),
          "a".repeat(ChatService.MAX_MESSAGE_LENGTH + 1),
        ),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.TooLong });

      expect(redis.hset).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("does not hold a line from the game to the website limit", async () => {
      const line = "g".repeat(ChatService.MAX_MESSAGE_LENGTH + 1);

      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          player(),
          line,
          true,
          "game",
        ),
      ).resolves.toEqual({ accepted: true });

      expect(stored("chat_match_m-1").at(0)?.message).toBe(line);
    });

    it("refuses someone who is not in the room", async () => {
      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-2",
          player(),
          "let me in",
        ),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });

      expect(redis.hset).not.toHaveBeenCalled();
    });

    describe("direct messages", () => {
      const room = directRoomId(ME, FRIEND);

      const dmInserts = () =>
        queries.filter(({ sql }) =>
          sql.includes("INSERT INTO public.direct_messages"),
        );

      it("delivers to a friend", async () => {
        seatIn(ME);

        await expect(
          service.sendMessageToChat(ChatLobbyType.Direct, room, player(), "hi"),
        ).resolves.toEqual({ accepted: true });

        expect(dmInserts().at(0)?.bindings.slice(1)).toEqual([room, ME, "hi"]);

        const incoming = redis.publish.mock.calls
          .map(([, payload]) => JSON.parse(payload))
          .find(({ event }) => event === "direct:incoming");

        expect(incoming.steamId).toBe(FRIEND);
        expect(incoming.data.message.source).toBe("web");
      });

      it("stops a conversation the moment the friendship ends", async () => {
        // Still seated in the room -- presence outlives the unfriend by up to
        // a day, so it cannot be what decides this.
        seatIn(ME);
        acceptedFriendships = [];

        await expect(
          service.sendMessageToChat(
            ChatLobbyType.Direct,
            room,
            player(),
            "still there?",
          ),
        ).resolves.toEqual({
          accepted: false,
          code: ChatErrorCode.NotAllowed,
        });

        expect(dmInserts()).toHaveLength(0);
        expect(redis.publish).not.toHaveBeenCalled();
      });

      it("hands back history stamped as website messages", async () => {
        postgres.query.mockResolvedValueOnce([
          {
            id: "dm-1",
            message: "old",
            created_at: new Date("2026-01-01T00:00:00Z"),
            steam_id: ME,
            name: "Someone",
            role: "user",
            avatar_url: null,
            profile_url: null,
          },
        ]);

        const [message] = await service["getDirectMessages"](room);

        expect(message).toMatchObject({
          id: "dm-1",
          source: "web",
          from: { steam_id: ME },
        });
      });
    });

    describe("who it is from", () => {
      const cache = (entries: Record<string, unknown>) =>
        redis.get.mockImplementation(async (key: string) =>
          key in entries ? JSON.stringify(entries[key]) : null,
        );

      const from = async () => {
        await service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          player({ name: "Fresh Name", role: "user" }),
          "hi",
          true,
        );

        return stored("chat_match_m-1").at(0).from;
      };

      it("keeps the player's own role when only the name is cached", async () => {
        cache({ [HasuraService.PLAYER_NAME_CACHE_KEY(ME)]: "Cached Name" });

        expect(await from()).toMatchObject({
          name: "Cached Name",
          role: "user",
        });
      });

      it("keeps the player's own name when only the role is cached", async () => {
        cache({ [HasuraService.PLAYER_ROLE_CACHE_KEY(ME)]: "administrator" });

        expect(await from()).toMatchObject({
          name: "Fresh Name",
          role: "administrator",
        });
      });

      it("prefers both cached values when both are there", async () => {
        cache({
          [HasuraService.PLAYER_NAME_CACHE_KEY(ME)]: "Cached Name",
          [HasuraService.PLAYER_ROLE_CACHE_KEY(ME)]: "match_organizer",
        });

        expect(await from()).toMatchObject({
          name: "Cached Name",
          role: "match_organizer",
        });
      });

      it("falls back when the cache holds null", async () => {
        cache({ [HasuraService.PLAYER_ROLE_CACHE_KEY(ME)]: null });

        expect((await from()).role).toBe("user");
      });
    });
  });

  describe("rosters", () => {
    it("resolves both parties of a conversation", async () => {
      expect(
        await service.getLobbyMemberSteamIds(
          ChatLobbyType.Direct,
          directRoomId(ME, FRIEND),
        ),
      ).toEqual([ME, FRIEND]);
    });

    // The organizers' room has no roster of its own, so an empty list here is
    // indistinguishable from a room nobody can be notified about -- which is
    // what it silently was.
    it("resolves the organizers' room through its role gate", async () => {
      staff = [ME, FRIEND];

      expect(
        await service.getLobbyMemberSteamIds(ChatLobbyType.Organizer, "x"),
      ).toEqual([ME, FRIEND]);

      const [{ players }] = hasuraService.query.mock.calls.at(-1);

      expect(players.__args.where.role._in).toEqual([
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ]);
    });

    it("has nobody to notify in a team room", async () => {
      expect(
        await service.getLobbyMemberSteamIds(ChatLobbyType.Team, "x"),
      ).toEqual([]);
    });
  });

  describe("read state", () => {
    const cursorWrites = () =>
      queries.filter(({ sql }) => sql.includes("chat_read_state"));

    it("ignores a room the caller is not part of", async () => {
      await service.markThreadRead(
        ChatLobbyType.Direct,
        directRoomId(FRIEND, STRANGER),
        { steam_id: ME } as any,
      );

      expect(cursorWrites()).toHaveLength(0);
    });

    it("records a read for a conversation the caller is in", async () => {
      await service.markThreadRead(
        ChatLobbyType.Direct,
        directRoomId(ME, FRIEND),
        { steam_id: ME } as any,
      );

      expect(cursorWrites().at(0)?.bindings).toEqual([
        ME,
        `chat:direct:${directRoomId(ME, FRIEND)}`,
      ]);
    });

    it("records a read for a lobby, not just a conversation", async () => {
      // The cursor is what stops a push firing for a match lobby the recipient
      // is already reading, which was the whole gap.
      await service.markThreadRead(ChatLobbyType.Match, "m-1", {
        steam_id: ME,
      } as any);

      expect(cursorWrites().at(0)?.bindings).toEqual([ME, "chat:match:m-1"]);
    });

    it("refuses a lobby the caller has no business in", async () => {
      // `type` and `id` are unvalidated socket input, so without the same gate
      // joining uses, a client can write a row per call for any id it invents.
      await service.markThreadRead(ChatLobbyType.Match, "m-2", {
        steam_id: ME,
      } as any);

      expect(cursorWrites()).toHaveLength(0);
    });
  });
});
