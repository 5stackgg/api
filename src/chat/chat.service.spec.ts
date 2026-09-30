import { ChatService } from "./chat.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { directRoomId } from "./utilities/directRoomId";
import { HasuraService } from "../hasura/hasura.service";
import { rolesAtOrAbove } from "../utilities/isRoleAbove";

const ME = "76561198000000001";
const FRIEND = "76561198000000002";
const STRANGER = "76561198000000003";
const MODERATORS = rolesAtOrAbove("moderator");

describe("ChatService direct messages", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const redis = {
    hset: jest.fn(),
    hget: jest.fn().mockResolvedValue(null),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
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
  let gagged: boolean;
  let audited: boolean;
  let editAuditIds: string[];
  let directReactions: Record<string, string[]> | null;
  let directReactionFailure: Error | undefined;
  // What a block committed between a send's access check and its insert does
  // to that insert.
  let dmInsertBlocked: boolean;
  // The one direct message the fake database holds, if a test put one there.
  let directMessage:
    | {
        id: string;
        roomId: string;
        author: string;
        message: string;
        open: boolean;
        editedAt: Date | null;
      }
    | undefined;

  const ownsDirectMessage = (bindings: any[]) =>
    directMessage !== undefined &&
    directMessage.id === bindings[0] &&
    directMessage.roomId === bindings[1] &&
    directMessage.author === bindings[2] &&
    directMessage.open;

  const postgres = {
    query: jest.fn(async (sql: string, bindings: any[]): Promise<any[]> => {
      queries.push({ sql, bindings });

      if (sql.includes("public.is_gagged")) {
        return [{ gagged }];
      }

      if (sql.includes("SELECT 1 FROM public.chat_message_deletions")) {
        return [{ deleted: audited }];
      }

      if (sql.includes("FOR NO KEY UPDATE")) {
        return directMessage?.id === bindings[0] &&
          directMessage.roomId === bindings[1]
          ? [{ locked: 1 }]
          : [];
      }

      if (sql.includes("INSERT INTO public.direct_message_reactions")) {
        if (directReactionFailure) {
          throw directReactionFailure;
        }
        return [];
      }

      if (sql.includes("SELECT reactions.reactions")) {
        return directMessage?.id === bindings[0]
          ? [{ reactions: directReactions }]
          : [];
      }

      if (sql.includes("INSERT INTO public.direct_messages")) {
        return dmInsertBlocked ? [] : [{ id: bindings[0] }];
      }

      if (sql.includes("INSERT INTO public.chat_message_edits")) {
        const id = `edit-audit-${editAuditIds.length + 1}`;
        editAuditIds.push(id);
        return [{ id }];
      }

      if (sql.includes("AS open")) {
        return directMessage?.id === bindings[0] &&
          directMessage.roomId === bindings[1]
          ? [{ author: directMessage.author, open: directMessage.open }]
          : [];
      }

      if (sql.includes("UPDATE public.direct_messages")) {
        if (!ownsDirectMessage(bindings)) {
          return [];
        }

        directMessage.message = bindings[4];
        directMessage.editedAt = new Date("2026-01-01T00:00:00.000Z");

        return [
          {
            message: directMessage.message,
            edited_at: directMessage.editedAt,
          },
        ];
      }

      if (sql.includes("DELETE FROM public.direct_messages")) {
        if (!ownsDirectMessage(bindings)) {
          return [];
        }

        const { id } = directMessage;
        directMessage = undefined;

        return [{ id }];
      }

      if (
        sql.includes("SELECT message, edited_at FROM public.direct_messages")
      ) {
        return directMessage?.id === bindings[0]
          ? [
              {
                message: directMessage.message,
                edited_at: directMessage.editedAt,
              },
            ]
          : [];
      }

      return [];
    }),
  };

  // Every statement in a transaction goes through the same fake as the rest.
  Object.assign(postgres, {
    transaction: jest.fn(async (work: (client: any) => Promise<unknown>) =>
      work({
        query: async (sql: string, bindings: any[]) => ({
          rows: await postgres.query(sql, bindings),
        }),
      }),
    ),
  });

  // [blocker, blocked]
  let blocks: Array<[string, string]>;

  const playerBlocks = {
    hasBlocked: jest.fn(async (blocker: string, blocked: string) =>
      blocks.some(([x, y]) => x === blocker && y === blocked),
    ),
    isBlockedEitherWay: jest.fn(async (a: string, b: string) =>
      blocks.some(
        ([blocker, blocked]) =>
          (blocker === a && blocked === b) || (blocker === b && blocked === a),
      ),
    ),
    blockedBy: jest.fn(
      async (viewer: string) =>
        new Set(
          blocks
            .filter(([blocker]) => blocker === viewer)
            .map(([, blocked]) => blocked),
        ),
    ),
    blockedAmong: jest.fn(async (viewers: string[], authors: string[]) => {
      const found = new Map<string, Set<string>>();

      for (const [blocker, blocked] of blocks) {
        if (viewers.includes(blocker) && authors.includes(blocked)) {
          found.set(blocker, (found.get(blocker) ?? new Set()).add(blocked));
        }
      }

      return found;
    }),
  };

  const notifications = {
    notifyPlayers: jest.fn(),
    collapseOlderUnread: jest.fn(),
    markConversationRead: jest.fn(),
    retractChatMessage: jest.fn().mockResolvedValue(undefined),
    retractChatMessageFromBlocked: jest.fn().mockResolvedValue(undefined),
    updateChatMessagePreview: jest.fn().mockResolvedValue(undefined),
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
  let pluginRuntime: string;
  // Matches this player can see but has no part in. Hasura answers
  // is_organizer with NULL, not false, for a match nobody organizes.
  let otherMatches: string[];
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
            server: { id: "server-1", plugin_runtime: pluginRuntime },
          },
        };
      }

      if (query.matches_by_pk) {
        const matchId = query.matches_by_pk.__args.id;

        if (otherMatches.includes(matchId)) {
          return {
            matches_by_pk: {
              is_coach: false,
              is_organizer: null,
              is_in_lineup: false,
            },
          };
        }

        return myMatches.includes(matchId)
          ? {
              matches_by_pk: {
                is_coach: false,
                is_organizer: false,
                is_in_lineup: true,
              },
            }
          : {};
      }

      if (query.match_lineups_by_pk) {
        return query.match_lineups_by_pk.__args.id === "l-1"
          ? {
              match_lineups_by_pk: {
                match_id: "m-1",
                coach_steam_id: null,
                is_on_lineup: true,
                lineup_players: [{ steam_id: ME }, { steam_id: FRIEND }],
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
    redis.hgetall.mockResolvedValue({});
    redis.hdel.mockResolvedValue(1);
    redis.get.mockResolvedValue(null);
    redis.eval.mockImplementation(async (script: string) =>
      script.includes("INCR") ? 1 : [1, 1],
    );
    notifications.retractChatMessage.mockResolvedValue(undefined);
    notifications.retractChatMessageFromBlocked.mockResolvedValue(undefined);
    notifications.updateChatMessagePreview.mockResolvedValue(undefined);
    directMessage = undefined;
    acceptedFriendships = [[ME, FRIEND]];
    myMatches = ["m-1"];
    pluginRuntime = "counterstrikesharp";
    otherMatches = ["mm-1"];
    tournament = {
      organizers: [STRANGER],
      teamOwners: [],
      roster: [],
      freeAgents: [],
    };
    staff = [];
    role = "user";
    queries = [];
    gagged = false;
    audited = false;
    editAuditIds = [];
    directReactions = null;
    directReactionFailure = undefined;
    dmInsertBlocked = false;
    blocks = [];
    rcon.send.mockResolvedValue(undefined);
    rcon.connect.mockResolvedValue(rcon);

    service = new ChatService(
      logger as any,
      { connect: rcon.connect } as any,
      hasuraService as any,
      postgres as any,
      { getConnection: () => redis } as any,
      notifications as any,
      playerBlocks as any,
    );
  });

  // Registering a session is the point of no return in joinMatchLobby -- every
  // rejection path returns before it.
  const joined = () => redis.eval.mock.calls.length > 0;

  describe("joining", () => {
    it("keeps a stranger out of a match nobody organizes", async () => {
      // Every matchmaking match: is_organizer comes back NULL, and a strict
      // `=== false` once read that as not-a-refusal.
      await service.joinMatchLobby(client(ME), ChatLobbyType.Match, "mm-1");

      expect(joined()).toBe(false);
    });

    it("lets a lineup player into their match", async () => {
      await service.joinMatchLobby(client(ME), ChatLobbyType.Match, "m-1");

      expect(joined()).toBe(true);
    });

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
    const relayed = async (message: string, isOrganizer?: boolean) => {
      await service.sendChatToServer("m-1", message, isOrganizer);
      return rcon.send.mock.calls.at(-1)?.[0] as string;
    };

    it("sends the message as one quoted argument", async () => {
      expect(await relayed("nice shot")).toBe('css_web_chat "nice shot" 0');
    });

    it("flattens a multi line message onto one line", async () => {
      expect(await relayed("top\nbottom")).toBe('css_web_chat "top bottom" 0');
      expect(await relayed("top\r\nbottom")).toBe(
        'css_web_chat "top bottom" 0',
      );
    });

    it("strips quotes so the message cannot escape the argument", async () => {
      expect(await relayed('x" ; quit ; say "')).not.toContain('"x"');
      expect(await relayed('x" ; quit ; say "')).toBe(
        'css_web_chat "x ; quit ; say" 0',
      );
    });

    it("ends an organizer's line with 1 and anyone else's with 0", async () => {
      expect(await relayed("[organizer] Luke: pause", true)).toBe(
        'css_web_chat "[organizer] Luke: pause" 1',
      );
      expect(await relayed("[organizer] Mallory: pause", false)).toBe(
        'css_web_chat "[organizer] Mallory: pause" 0',
      );
    });

    it("strips U+200B, which SwiftlyS2 reads as a quote", async () => {
      pluginRuntime = "swiftly";

      expect(await relayed("gg\u200b 1\u200b wp")).toBe(
        'sw_web_chat "gg 1 wp" 0',
      );
    });

    it.each([
      ['Mallory: gg" 1'],
      ['Mallory: gg" "1'],
      ["Mallory: gg\u200b 1"],
      ["Mallory: gg\u200b\u200b1\u200b"],
    ])("keeps the line one argument before the flag in %j", async (message) => {
      pluginRuntime = "swiftly";

      const command = await relayed(message);
      const quoted = command.slice(
        'sw_web_chat "'.length,
        command.lastIndexOf('"'),
      );

      expect(command.endsWith('" 0')).toBe(true);
      expect(quoted).not.toMatch(/["\u200b]/);
    });

    const argument = (command: string) =>
      command.slice('css_web_chat "'.length, command.lastIndexOf('"'));

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

    it("never cuts a joined emoji or a flag apart", async () => {
      const family = "👨‍👩‍👧";
      const flag = "🇸🇪";

      // 5 and 2 code points each, so neither lands exactly on the limit.
      expect(argument(await relayed(family.repeat(100)))).toBe(
        `${family.repeat(47)}…`,
      );
      expect(argument(await relayed(flag.repeat(200)))).toBe(
        `${flag.repeat(119)}…`,
      );
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

  describe("notification type", () => {
    it.each([ChatLobbyType.Match, ChatLobbyType.MatchTeam])(
      "files %s chat under match chat",
      (type) => {
        expect(ChatService.notificationTypeFor(type)).toBe("MatchChatMessage");
      },
    );

    it.each([
      ChatLobbyType.Direct,
      ChatLobbyType.Tournament,
      ChatLobbyType.MatchMaking,
      ChatLobbyType.Draft,
      ChatLobbyType.Organizer,
    ])("files %s chat as a plain chat message", (type) => {
      expect(ChatService.notificationTypeFor(type)).toBe("ChatMessage");
    });

    it("notifies and collapses a team room line under one type", async () => {
      await service.sendMessageToChat(
        ChatLobbyType.MatchTeam,
        "m-1:l-1",
        { steam_id: ME, name: "Someone", role } as any,
        "rotate b",
        true,
        "game",
      );

      for (let tick = 0; tick < 5; tick++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "MatchChatMessage",
        expect.objectContaining({
          entity_id: "match_team:m-1:l-1",
          steamIds: [FRIEND],
        }),
      );
      expect(notifications.collapseOlderUnread).toHaveBeenCalledWith(
        "MatchChatMessage",
        "match_team:m-1:l-1",
        [FRIEND],
      );
    });

    it("clears a team room's badge under the type it was sent with", async () => {
      await service.markThreadRead(ChatLobbyType.MatchTeam, "m-1:l-1", {
        steam_id: ME,
      } as any);

      expect(notifications.markConversationRead).toHaveBeenCalledWith(
        "MatchChatMessage",
        "match_team:m-1:l-1",
        ME,
      );
    });
  });

  describe("live delivery", () => {
    const present = (key: string, steamIds: string[]) =>
      redis.hgetall.mockImplementation(async (hash: string) =>
        hash === key
          ? Object.fromEntries(
              steamIds.map((steamId) => [
                steamId,
                JSON.stringify({ user: { steam_id: steamId } }),
              ]),
            )
          : {},
      );

    const deliveredTo = () =>
      redis.publish.mock.calls
        .map(([, payload]) => JSON.parse(payload))
        .filter(({ event }) => event.endsWith(":chat"))
        .map(({ steamId }) => steamId);

    afterEach(() => {
      redis.hgetall.mockResolvedValue({});
    });

    it("keeps a team room's lines from someone no longer on the lineup", async () => {
      // still present from when they were on it: presence is only cleared on
      // leave, and outlives a move to the other lineup
      present("chat:match_team:m-1:l-1", [ME, FRIEND, STRANGER]);

      await service.to(ChatLobbyType.MatchTeam, "m-1:l-1", "chat", {}, ME);

      expect(deliveredTo()).toEqual([ME, FRIEND]);
    });

    it("still reaches everyone present in a match room", async () => {
      present("chat:match:m-1", [ME, FRIEND, STRANGER]);

      await service.to(ChatLobbyType.Match, "m-1", "chat", {}, ME);

      expect(deliveredTo()).toEqual([ME, FRIEND, STRANGER]);
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
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });

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
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });

      expect(stored("chat_match_m-1").at(0)?.message).toBe(line);
    });

    it("answers with the id the message was stored under", async () => {
      seatIn(ME);

      const result = await service.sendMessageToChat(
        ChatLobbyType.Match,
        "m-1",
        player(),
        "hello",
      );

      expect(result).toEqual({
        accepted: true,
        messageId: stored("chat_match_m-1").at(0).id,
      });
    });

    it("refuses a player no longer on the match, though still seated", async () => {
      // Presence outlives a lineup change: a player swapped out mid-match
      // keeps the page, and the room, open.
      seatIn(ME);
      myMatches = [];

      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          player(),
          "still here",
        ),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });

      expect(redis.hset).not.toHaveBeenCalled();
    });

    it("refuses a stranger seated in a match nobody organizes", async () => {
      seatIn(ME);

      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          "mm-1",
          player(),
          "hello from outside",
        ),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });

      expect(redis.hset).not.toHaveBeenCalled();
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
        ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });

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

  describe("gag", () => {
    const player = () =>
      ({ steam_id: ME, name: "Someone", role: "user" }) as any;

    const groupRooms = [
      ChatLobbyType.Match,
      ChatLobbyType.MatchTeam,
      ChatLobbyType.MatchMaking,
      ChatLobbyType.Tournament,
      ChatLobbyType.Draft,
      ChatLobbyType.Organizer,
      ChatLobbyType.Team,
    ];

    beforeEach(() => {
      gagged = true;
    });

    it.each(groupRooms)(
      "keeps a gagged player's website message out of a %s room",
      async (type) => {
        await expect(
          service.sendMessageToChat(type, "x", player(), "hello", true),
        ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Gagged });

        expect(redis.hset).not.toHaveBeenCalled();
        expect(redis.publish).not.toHaveBeenCalled();
        expect(notifications.notifyPlayers).not.toHaveBeenCalled();
      },
    );

    it("refuses a gagged player in a room they belong to", async () => {
      redis.hget.mockResolvedValue(JSON.stringify({ user: { steam_id: ME } }));

      await expect(
        service.sendMessageToChat(ChatLobbyType.Match, "m-1", player(), "hi"),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Gagged });

      const [check] = queries.filter(({ sql }) =>
        sql.includes("public.is_gagged"),
      );

      expect(check.bindings).toEqual([ME]);
    });

    it("answers not_allowed rather than gagged for a room they are not in", async () => {
      await expect(
        service.sendMessageToChat(ChatLobbyType.Match, "m-2", player(), "hi"),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });
    });

    it("leaves a gagged player's direct messages alone", async () => {
      redis.hget.mockResolvedValue(JSON.stringify({ user: { steam_id: ME } }));

      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Direct,
          directRoomId(ME, FRIEND),
          player(),
          "hi",
        ),
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });

      expect(queries.some(({ sql }) => sql.includes("public.is_gagged"))).toBe(
        false,
      );
    });

    it("leaves a line relayed from the game to the game server's gag", async () => {
      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          player(),
          "from the server",
          true,
          "game",
        ),
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });
    });

    it("lets a player post once the gag is lifted", async () => {
      gagged = false;

      await expect(
        service.sendMessageToChat(
          ChatLobbyType.Tournament,
          "t-1",
          player(),
          "back",
          true,
        ),
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });
    });
  });

  describe("website message rate", () => {
    let rates: Record<string, number>;

    const player = () =>
      ({ steam_id: ME, name: "Someone", role: "user" }) as any;

    const send = (source: "web" | "game" = "web") =>
      service.sendMessageToChat(
        ChatLobbyType.Match,
        "m-1",
        player(),
        "gg",
        false,
        source,
      );

    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    beforeEach(() => {
      rates = {};
      redis.hget.mockResolvedValue(JSON.stringify({ user: { steam_id: ME } }));
      redis.eval.mockImplementation(
        async (script: string, _keys: number, key: string) => {
          if (script.includes("INCR")) {
            rates[key] = (rates[key] ?? 0) + 1;
            return rates[key];
          }
          return [1, 1];
        },
      );
    });

    it("refuses a player's sixth message in a window before any other work", async () => {
      for (let n = 0; n < 5; n++) {
        await expect(send()).resolves.toEqual({
          accepted: true,
          messageId: expect.any(String),
        });
      }
      await settle();
      jest.clearAllMocks();
      queries = [];

      await expect(send()).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.RateLimited,
      });
      await settle();

      expect(hasuraService.query).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
      expect(redis.hget).not.toHaveBeenCalled();
      expect(redis.hset).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("keys the count to the player, with a three second expiry", async () => {
      await send();

      const rate = redis.eval.mock.calls.find(([script]) =>
        script.includes("INCR"),
      );

      expect(rate.slice(1)).toEqual([1, `chat:message-rate:${ME}`, 3_000]);
      expect(rate[0]).toContain("PEXPIRE");
    });

    it("never limits a line relayed from the game", async () => {
      for (let n = 0; n < 10; n++) {
        await expect(send("game")).resolves.toMatchObject({ accepted: true });
      }

      expect(rates).toEqual({});
    });
  });

  describe("deleting", () => {
    const MESSAGE_ID = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

    const moderator = (overrides: Record<string, unknown> = {}) =>
      ({ steam_id: ME, name: "Mod", role: "moderator", ...overrides }) as any;

    let stored: Record<string, Record<string, string>>;

    const store = (
      type: ChatLobbyType,
      id: string,
      message: Record<string, unknown> = {},
    ) => {
      stored[`chat_${type}_${id}`] = {
        ...stored[`chat_${type}_${id}`],
        [MESSAGE_ID]: JSON.stringify({
          id: MESSAGE_ID,
          message: "something awful",
          timestamp: "2025-01-01T00:00:00.000Z",
          source: "web",
          from: { role: "user", name: "Author", steam_id: FRIEND },
          ...message,
        }),
      };
    };

    const audits = () =>
      queries.filter(({ sql }) =>
        sql.includes("INSERT INTO public.chat_message_deletions"),
      );

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      role = "moderator";
      stored = {};
      redis.hget.mockImplementation(
        async (key: string, field: string) => stored[key]?.[field] ?? null,
      );
    });

    it("lets a moderator remove a message from a room they are in, however old", async () => {
      store(ChatLobbyType.Match, "m-1");
      redis.hgetall.mockImplementation(async (key: string) =>
        key === "chat:match:m-1"
          ? { [FRIEND]: JSON.stringify({ user: { steam_id: FRIEND } }) }
          : {},
      );

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          moderator(),
        ),
      ).resolves.toEqual({ deleted: true });

      expect(redis.hdel).toHaveBeenCalledWith("chat_match_m-1", MESSAGE_ID);

      await flush();

      const broadcast = redis.publish.mock.calls
        .map(([, payload]) => JSON.parse(payload))
        .find(({ event }) => event === "lobby:match:m-1:deleted");

      expect(broadcast).toEqual({
        steamId: FRIEND,
        event: "lobby:match:m-1:deleted",
        data: { id: MESSAGE_ID },
      });
    });

    it("keeps the evidence of what was removed", async () => {
      store(ChatLobbyType.Match, "m-1");

      await service.deleteMessage(
        ChatLobbyType.Match,
        "m-1",
        MESSAGE_ID,
        moderator(),
      );

      expect(audits().at(0)?.bindings).toEqual([
        MESSAGE_ID,
        "match",
        "m-1",
        FRIEND,
        "something awful",
        "2025-01-01T00:00:00.000Z",
        "web",
        ME,
      ]);
    });

    it("writes the audit row before the message is removed", async () => {
      store(ChatLobbyType.Match, "m-1");

      await service.deleteMessage(
        ChatLobbyType.Match,
        "m-1",
        MESSAGE_ID,
        moderator(),
      );

      const auditCall = postgres.query.mock.calls.findIndex(([sql]) =>
        sql.includes("INSERT INTO public.chat_message_deletions"),
      );

      expect(postgres.query.mock.invocationCallOrder[auditCall]).toBeLessThan(
        redis.hdel.mock.invocationCallOrder[0],
      );
    });

    it("leaves the message in place when the audit row cannot be written", async () => {
      store(ChatLobbyType.Match, "m-1");
      postgres.query.mockRejectedValueOnce(new Error("database down"));

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          moderator(),
        ),
      ).rejects.toThrow("database down");

      expect(redis.hdel).not.toHaveBeenCalled();
      expect(notifications.retractChatMessage).not.toHaveBeenCalled();
    });

    it("records no author for a steam id stored as a number", async () => {
      store(ChatLobbyType.Match, "m-1", {
        from: { role: "user", name: "Author", steam_id: 76561198000000002 },
      });

      await service.deleteMessage(
        ChatLobbyType.Match,
        "m-1",
        MESSAGE_ID,
        moderator(),
      );

      expect(audits().at(0)?.bindings[3]).toBeNull();
    });

    it("retracts the message's notifications", async () => {
      store(ChatLobbyType.Match, "m-1");

      await service.deleteMessage(
        ChatLobbyType.Match,
        "m-1",
        MESSAGE_ID,
        moderator(),
      );

      expect(notifications.retractChatMessage).toHaveBeenCalledWith(MESSAGE_ID);
    });

    it("still deletes when the retraction fails", async () => {
      store(ChatLobbyType.Match, "m-1");
      notifications.retractChatMessage.mockRejectedValue(new Error("nope"));

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          moderator(),
        ),
      ).resolves.toEqual({ deleted: true });
    });

    it("refuses a streamer", async () => {
      role = "streamer";
      store(ChatLobbyType.Match, "m-1");

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          moderator({ role: "streamer" }),
        ),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotAllowed });

      expect(audits()).toHaveLength(0);
      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it("goes by the role on record, not the one the socket signed in with", async () => {
      role = "user";
      store(ChatLobbyType.Match, "m-1");

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          moderator({ role: "administrator" }),
        ),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotAllowed });

      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it("refuses a moderator in a room they cannot get into", async () => {
      store(ChatLobbyType.Match, "m-2");

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-2",
          MESSAGE_ID,
          moderator(),
        ),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotAllowed });

      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it("does not let an administrator moderate a direct conversation", async () => {
      role = "administrator";
      directMessage = {
        id: MESSAGE_ID,
        roomId: directRoomId(ME, FRIEND),
        author: FRIEND,
        message: "something awful",
        open: true,
        editedAt: null,
      };

      await expect(
        service.deleteMessage(
          ChatLobbyType.Direct,
          directRoomId(ME, FRIEND),
          MESSAGE_ID,
          moderator({ role: "administrator" }),
        ),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotAllowed });

      expect(directMessage).toBeDefined();
      expect(audits()).toHaveLength(0);
    });

    it("answers not_found for a message that is not there", async () => {
      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          moderator(),
        ),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotFound });

      expect(audits()).toHaveLength(0);
      expect(redis.hdel).not.toHaveBeenCalled();
    });

    it("answers not_found for an id that could never be a message", async () => {
      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          "not-a-uuid",
          moderator(),
        ),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotFound });

      expect(redis.hget).not.toHaveBeenCalled();
    });

    describe("while its notifications are still being written", () => {
      const sayInTournament = async () => {
        tournament.roster = [ME, FRIEND];
        redis.hget.mockResolvedValue(
          JSON.stringify({ user: { steam_id: ME } }),
        );
        role = "user";

        const result = await service.sendMessageToChat(
          ChatLobbyType.Tournament,
          "t-1",
          { steam_id: ME, name: "Someone", role: "user" } as any,
          "hi",
        );

        await flush();
        await flush();

        return result.accepted ? result.messageId : undefined;
      };

      it("retracts them once written if the message was deleted meanwhile", async () => {
        audited = true;

        const messageId = await sayInTournament();

        expect(notifications.notifyPlayers).toHaveBeenCalled();
        expect(
          queries.find(({ sql }) =>
            sql.includes("SELECT 1 FROM public.chat_message_deletions"),
          )?.bindings,
        ).toEqual([messageId]);
        expect(notifications.retractChatMessage).toHaveBeenCalledWith(
          messageId,
        );
      });

      it("leaves them alone when nothing deleted the message", async () => {
        await sayInTournament();

        expect(notifications.notifyPlayers).toHaveBeenCalled();
        expect(notifications.retractChatMessage).not.toHaveBeenCalled();
      });
    });

    it("stamps each chat notification with the message it announces", async () => {
      redis.hget.mockResolvedValue(JSON.stringify({ user: { steam_id: ME } }));
      role = "user";

      const result = await service.sendMessageToChat(
        ChatLobbyType.Direct,
        directRoomId(ME, FRIEND),
        { steam_id: ME, name: "Someone", role: "user" } as any,
        "hi",
      );

      await flush();

      expect(result.accepted).toBe(true);
      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "ChatMessage",
        expect.objectContaining({
          data: expect.objectContaining({
            messageId: result.accepted ? result.messageId : undefined,
          }),
        }),
      );
    });
  });

  describe("editing and deleting your own messages", () => {
    const MESSAGE_ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const WINDOW = ChatService.SELF_SERVICE_WINDOW_MS;

    let stored: Record<string, Record<string, string>>;

    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    const store = (message: Record<string, unknown> = {}, id = "m-1") => {
      stored[`chat_match_${id}`] = {
        [MESSAGE_ID]: JSON.stringify({
          id: MESSAGE_ID,
          message: "typo",
          timestamp: ago(60_000),
          source: "web",
          from: {
            role: "user",
            name: "Me",
            steam_id: ME,
            avatar_url: null,
            profile_url: "https://steamcommunity.com/id/me/",
          },
          ...message,
        }),
      };
    };

    const current = (id = "m-1") =>
      JSON.parse(stored[`chat_match_${id}`]?.[MESSAGE_ID] ?? "null");

    const me = (overrides: Record<string, unknown> = {}) =>
      ({ steam_id: ME, name: "Me", role: "user", ...overrides }) as any;

    const edit = (text = "fixed", user = me(), id = "m-1") =>
      service.editMessage(ChatLobbyType.Match, id, MESSAGE_ID, user, text);

    const selfDelete = (user = me(), id = "m-1") =>
      service.deleteMessage(ChatLobbyType.Match, id, MESSAGE_ID, user);

    const broadcasts = (event: string) =>
      redis.publish.mock.calls
        .map(([, payload]) => JSON.parse(payload))
        .filter((published) => published.event === event);

    const audits = () =>
      queries.filter(({ sql }) =>
        sql.includes("INSERT INTO public.chat_message_deletions"),
      );

    const editAudits = () =>
      queries.filter(({ sql }) =>
        sql.includes("INSERT INTO public.chat_message_edits"),
      );

    const discardedEditAudits = () =>
      queries
        .filter(({ sql }) =>
          sql.includes("DELETE FROM public.chat_message_edits"),
        )
        .map(({ bindings }) => bindings[0]);

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      stored = {};
      redis.hget.mockImplementation(
        async (key: string, field: string) => stored[key]?.[field] ?? null,
      );
      redis.hgetall.mockImplementation(async (key: string) =>
        key === "chat:match:m-1"
          ? { [FRIEND]: JSON.stringify({ user: { steam_id: FRIEND } }) }
          : {},
      );
      redis.hdel.mockImplementation(async (key: string, field: string) => {
        delete stored[key]?.[field];
        return 1;
      });
      redis.eval.mockImplementation(
        async (
          script: string,
          _keys: number,
          key: string,
          _receipt: string,
          field: string,
          expected: string,
          next: string,
        ) => {
          if (script.includes("INCR")) {
            return 1;
          }

          if (!script.includes("HPEXPIRETIME")) {
            return [1, 1];
          }

          if (stored[key]?.[field] !== expected) {
            return 0;
          }

          stored[key][field] = next;
          return 1;
        },
      );
    });

    describe("in a room", () => {
      it("lets the author change what they wrote within the window", async () => {
        store();
        const before = current();

        const result = await edit("  fixed  ");

        expect(result).toEqual({
          edited: true,
          message: "fixed",
          edited_at: expect.any(String),
        });
        expect(current()).toEqual({
          ...before,
          message: "fixed",
          edited_at: result.edited ? result.edited_at : undefined,
        });
      });

      it("tells the room what the message says now", async () => {
        store();

        const result = await edit();
        await flush();

        expect(broadcasts("lobby:match:m-1:edited")).toEqual([
          {
            steamId: FRIEND,
            event: "lobby:match:m-1:edited",
            data: {
              id: MESSAGE_ID,
              message: "fixed",
              edited_at: result.edited ? result.edited_at : undefined,
            },
          },
        ]);
        expect(broadcasts("lobby:match:m-1:chat")).toEqual([]);
      });

      it("rewrites the bell's preview rather than notifying again", async () => {
        store();

        await edit("<b>fixed</b>");
        await flush();

        expect(notifications.updateChatMessagePreview).toHaveBeenCalledWith(
          MESSAGE_ID,
          "&lt;b&gt;fixed&lt;/b&gt;",
        );
        expect(notifications.notifyPlayers).not.toHaveBeenCalled();
      });

      it("still edits when the preview cannot be rewritten", async () => {
        store();
        notifications.updateChatMessagePreview.mockRejectedValue(
          new Error("database down"),
        );

        await expect(edit()).resolves.toMatchObject({ edited: true });
        expect(current().message).toBe("fixed");
      });

      it("never relays an edit to the game server", async () => {
        store();

        await edit();
        await flush();

        expect(rcon.connect).not.toHaveBeenCalled();
      });

      it("keeps what the message said before the edit", async () => {
        store();
        const { timestamp } = current();

        const result = await edit();

        expect(editAudits().map(({ bindings }) => bindings)).toEqual([
          [
            MESSAGE_ID,
            "match",
            "m-1",
            ME,
            "typo",
            "fixed",
            timestamp,
            result.edited ? result.edited_at : undefined,
          ],
        ]);
        expect(discardedEditAudits()).toEqual([]);
      });

      it("writes the audit row before the message changes", async () => {
        store();

        await edit();

        const auditCall = postgres.query.mock.calls.findIndex(([sql]) =>
          sql.includes("INSERT INTO public.chat_message_edits"),
        );
        const swapCall = redis.eval.mock.calls.findIndex(([script]) =>
          script.includes("HPEXPIRETIME"),
        );

        expect(auditCall).toBeGreaterThanOrEqual(0);
        expect(postgres.query.mock.invocationCallOrder[auditCall]).toBeLessThan(
          redis.eval.mock.invocationCallOrder[swapCall],
        );
      });

      it("leaves the message as it was when the audit row cannot be written", async () => {
        store();
        const database = postgres.query.getMockImplementation();
        postgres.query.mockImplementation(async (sql, bindings) => {
          if (sql.includes("INSERT INTO public.chat_message_edits")) {
            throw new Error("database down");
          }
          return database(sql, bindings);
        });

        try {
          await expect(edit()).rejects.toThrow("database down");
        } finally {
          postgres.query.mockImplementation(database);
        }

        await flush();

        expect(current().message).toBe("typo");
        expect(
          redis.eval.mock.calls.some(([script]) =>
            script.includes("HPEXPIRETIME"),
          ),
        ).toBe(false);
        expect(broadcasts("lobby:match:m-1:edited")).toEqual([]);
      });

      it("keeps the audit row when the swap fails outright, since it may have applied", async () => {
        store();
        redis.eval.mockRejectedValueOnce(new Error("connection reset"));

        await expect(edit()).rejects.toThrow("connection reset");

        expect(editAudits()).toHaveLength(1);
        expect(discardedEditAudits()).toEqual([]);
      });

      it("hands the swap a receipt named for its own audit row", async () => {
        store();

        await edit();

        const swap = redis.eval.mock.calls.find(([script]) =>
          script.includes("HPEXPIRETIME"),
        );

        expect(swap.slice(1, 4)).toEqual([
          2,
          "chat_match_m-1",
          "chat_edit_applied:edit-audit-1",
        ]);
      });

      it("still retries when an audit row it no longer needs cannot be discarded", async () => {
        store();
        redis.hget.mockImplementationOnce(
          async (key: string, field: string) => {
            const raw = stored[key][field];
            stored[key][field] = JSON.stringify({
              ...JSON.parse(raw),
              message: "other tab",
            });
            return raw;
          },
        );
        const database = postgres.query.getMockImplementation();
        postgres.query.mockImplementation(async (sql, bindings) => {
          if (sql.includes("DELETE FROM public.chat_message_edits")) {
            throw new Error("database blip");
          }
          return database(sql, bindings);
        });

        try {
          await expect(edit()).resolves.toMatchObject({ edited: true });
        } finally {
          postgres.query.mockImplementation(database);
        }

        expect(current().message).toBe("fixed");
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("unable to discard"),
          expect.any(Error),
        );
      });

      it("audits nothing for an edit it refuses", async () => {
        store({ timestamp: ago(WINDOW + 6_000) });
        await edit();

        store();
        gagged = true;
        await edit();

        store({ source: "game" });
        await edit();

        expect(editAudits()).toEqual([]);
      });

      it.each([
        ["another player", { steam_id: FRIEND }],
        ["an administrator", { steam_id: FRIEND, role: "administrator" }],
      ])("refuses %s", async (_, overrides) => {
        store();
        role = (overrides as { role?: string }).role ?? "user";

        await expect(edit("mine now", me(overrides))).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotAllowed,
        });
        expect(current().message).toBe("typo");
      });

      it.each([
        ["stored before source was recorded", { source: undefined }],
        ["relayed from the game", { source: "game" }],
      ])("refuses a message %s", async (_, overrides) => {
        store(overrides);

        await expect(edit()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotAllowed,
        });
        expect(current().message).toBe("typo");
      });

      it("refuses once the window has closed", async () => {
        store({ timestamp: ago(WINDOW + 6_000) });

        await expect(edit()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.WindowClosed,
        });
        expect(current().message).toBe("typo");
      });

      it("allows for a few seconds of clock skew between pods", async () => {
        store({ timestamp: ago(WINDOW + 2_000) });

        await expect(edit()).resolves.toMatchObject({ edited: true });
      });

      it("keeps a gagged author from editing", async () => {
        store();
        gagged = true;

        await expect(edit()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.Gagged,
        });
        expect(current().message).toBe("typo");
      });

      it("refuses an author who can no longer get into the room", async () => {
        store({}, "m-2");

        await expect(edit("fixed", me(), "m-2")).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotAllowed,
        });
      });

      it("refuses an edit over the limit", async () => {
        store();

        await expect(
          edit("a".repeat(ChatService.MAX_MESSAGE_LENGTH + 1)),
        ).resolves.toEqual({ edited: false, code: ChatErrorCode.TooLong });
        expect(current().message).toBe("typo");
      });

      it("answers not_found for a message that is not there", async () => {
        await expect(edit()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotFound,
        });
      });

      it("answers not_found for an id that could never be a message", async () => {
        await expect(
          service.editMessage(
            ChatLobbyType.Match,
            "m-1",
            "not-a-uuid",
            me(),
            "fixed",
          ),
        ).resolves.toEqual({ edited: false, code: ChatErrorCode.NotFound });
        expect(redis.hget).not.toHaveBeenCalled();
      });

      it("does not bring back a message deleted between the read and the write", async () => {
        store();
        redis.hget.mockImplementationOnce(
          async (key: string, field: string) => {
            const raw = stored[key][field];
            delete stored[key][field];
            return raw;
          },
        );

        await expect(edit()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotFound,
        });
        expect(current()).toBeNull();
        expect(broadcasts("lobby:match:m-1:edited")).toEqual([]);
        expect(discardedEditAudits()).toEqual(editAuditIds);
        expect(editAuditIds).toHaveLength(1);
      });

      it("applies an edit on top of one that landed between the read and the write", async () => {
        store();
        redis.hget.mockImplementationOnce(
          async (key: string, field: string) => {
            const raw = stored[key][field];
            stored[key][field] = JSON.stringify({
              ...JSON.parse(raw),
              message: "other tab",
              edited_at: new Date().toISOString(),
            });
            return raw;
          },
        );

        await expect(edit()).resolves.toMatchObject({ edited: true });
        expect(current().message).toBe("fixed");
        expect(editAudits().map(({ bindings }) => bindings[4])).toEqual([
          "typo",
          "other tab",
        ]);
        expect(discardedEditAudits()).toEqual(["edit-audit-1"]);
      });

      it("lets the author delete their own message, and audits it", async () => {
        store();

        await expect(selfDelete()).resolves.toEqual({ deleted: true });

        expect(current()).toBeNull();
        expect(audits().at(0)?.bindings).toEqual([
          MESSAGE_ID,
          "match",
          "m-1",
          ME,
          "typo",
          expect.any(String),
          "web",
          ME,
        ]);
        expect(notifications.retractChatMessage).toHaveBeenCalledWith(
          MESSAGE_ID,
        );
      });

      it("lets a gagged author delete their own message", async () => {
        store();
        gagged = true;

        await expect(selfDelete()).resolves.toEqual({ deleted: true });
      });

      it("refuses the author's delete once the window has closed", async () => {
        store({ timestamp: ago(WINDOW + 6_000) });

        await expect(selfDelete()).resolves.toEqual({
          deleted: false,
          code: ChatErrorCode.WindowClosed,
        });
        expect(audits()).toHaveLength(0);
        expect(current().message).toBe("typo");
      });

      it("refuses the author's delete of a line relayed from the game", async () => {
        store({ source: "game" });

        await expect(selfDelete()).resolves.toEqual({
          deleted: false,
          code: ChatErrorCode.NotAllowed,
        });
      });

      it("still lets a moderator delete after the window", async () => {
        role = "moderator";
        store({ timestamp: ago(WINDOW * 10) });

        await expect(selfDelete(me({ role: "moderator" }))).resolves.toEqual({
          deleted: true,
        });
      });
    });

    describe("in a direct conversation", () => {
      const room = directRoomId(ME, FRIEND);

      const hold = (overrides: Partial<typeof directMessage> = {}) => {
        directMessage = {
          id: MESSAGE_ID,
          roomId: room,
          author: ME,
          message: "typo",
          open: true,
          editedAt: null,
          ...overrides,
        };
      };

      const editDirect = (user = me()) =>
        service.editMessage(
          ChatLobbyType.Direct,
          room,
          MESSAGE_ID,
          user,
          "fixed",
        );

      const deleteDirect = (user = me()) =>
        service.deleteMessage(ChatLobbyType.Direct, room, MESSAGE_ID, user);

      const statements = (verb: string) =>
        queries.filter(({ sql }) =>
          sql.includes(`${verb} public.direct_messages`),
        );

      beforeEach(() => {
        redis.hgetall.mockImplementation(async (key: string) =>
          key === `chat:direct:${room}`
            ? { [FRIEND]: JSON.stringify({ user: { steam_id: FRIEND } }) }
            : {},
        );
      });

      it("lets the author edit within the window", async () => {
        hold();

        await expect(editDirect()).resolves.toEqual({
          edited: true,
          message: "fixed",
          edited_at: "2026-01-01T00:00:00.000Z",
        });
        await flush();

        expect(statements("UPDATE").at(0)?.bindings).toEqual([
          MESSAGE_ID,
          room,
          ME,
          600,
          "fixed",
        ]);
        expect(broadcasts(`lobby:direct:${room}:edited`)).toEqual([
          {
            steamId: FRIEND,
            event: `lobby:direct:${room}:edited`,
            data: {
              id: MESSAGE_ID,
              message: "fixed",
              edited_at: "2026-01-01T00:00:00.000Z",
            },
          },
        ]);
        expect(notifications.updateChatMessagePreview).toHaveBeenCalledWith(
          MESSAGE_ID,
          "fixed",
        );
      });

      it("never audits the edit of a direct message", async () => {
        hold();

        await expect(editDirect()).resolves.toMatchObject({ edited: true });

        expect(
          queries.some(({ sql }) => sql.includes("chat_message_edits")),
        ).toBe(false);
      });

      it("is not held back by a gag", async () => {
        hold();
        gagged = true;

        await expect(editDirect()).resolves.toMatchObject({ edited: true });
        expect(
          queries.some(({ sql }) => sql.includes("public.is_gagged")),
        ).toBe(false);
      });

      it("refuses the other party's message", async () => {
        hold({ author: FRIEND });

        await expect(editDirect()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotAllowed,
        });
        expect(statements("UPDATE")).toHaveLength(0);
      });

      it("refuses once the window has closed", async () => {
        hold({ open: false });

        await expect(editDirect()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.WindowClosed,
        });
        await expect(deleteDirect()).resolves.toEqual({
          deleted: false,
          code: ChatErrorCode.WindowClosed,
        });
        expect(statements("UPDATE")).toHaveLength(0);
        expect(statements("DELETE FROM")).toHaveLength(0);
      });

      it("refuses once the friendship is gone, before reading anything", async () => {
        hold();
        acceptedFriendships = [];

        await expect(editDirect()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotAllowed,
        });
        await expect(deleteDirect()).resolves.toEqual({
          deleted: false,
          code: ChatErrorCode.NotAllowed,
        });
        expect(queries).toHaveLength(0);
      });

      it("answers not_found for a message that is not there", async () => {
        await expect(editDirect()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotFound,
        });
      });

      it("says why when the row changed between the read and the write", async () => {
        hold();
        postgres.query.mockImplementationOnce(async (sql, bindings) => {
          queries.push({ sql, bindings });
          const row = { author: ME, open: true };
          directMessage = undefined;
          return [row];
        });

        await expect(editDirect()).resolves.toEqual({
          edited: false,
          code: ChatErrorCode.NotFound,
        });
        expect(broadcasts(`lobby:direct:${room}:edited`)).toEqual([]);
      });

      it("lets the author delete within the window, without an audit", async () => {
        hold();

        await expect(deleteDirect()).resolves.toEqual({ deleted: true });
        await flush();

        expect(directMessage).toBeUndefined();
        expect(audits()).toHaveLength(0);
        expect(broadcasts(`lobby:direct:${room}:deleted`)).toEqual([
          {
            steamId: FRIEND,
            event: `lobby:direct:${room}:deleted`,
            data: { id: MESSAGE_ID },
          },
        ]);
        expect(notifications.retractChatMessage).toHaveBeenCalledWith(
          MESSAGE_ID,
        );
      });

      it("refuses to delete the other party's message", async () => {
        hold({ author: FRIEND });

        await expect(deleteDirect()).resolves.toEqual({
          deleted: false,
          code: ChatErrorCode.NotAllowed,
        });
        expect(directMessage).toBeDefined();
      });
    });

    describe("while its notifications are still being written", () => {
      const say = async (type: ChatLobbyType, id: string) => {
        redis.hget.mockImplementation(async (key: string, field: string) =>
          key.startsWith("chat:")
            ? JSON.stringify({ user: { steam_id: ME } })
            : (stored[key]?.[field] ?? null),
        );

        const result = await service.sendMessageToChat(type, id, me(), "typo");

        return result.accepted ? result.messageId : undefined;
      };

      it("gives the rows a room message's edited text", async () => {
        tournament.roster = [ME, FRIEND];
        notifications.notifyPlayers.mockImplementationOnce(async () => {
          const [key] = redis.hset.mock.calls.at(-1);
          const [field, raw] = redis.hset.mock.calls.at(-1).slice(1);
          stored[key] = {
            [field]: JSON.stringify({
              ...JSON.parse(raw),
              message: "fixed",
              edited_at: new Date().toISOString(),
            }),
          };
        });

        const messageId = await say(ChatLobbyType.Tournament, "t-1");
        await flush();
        await flush();

        expect(notifications.updateChatMessagePreview).toHaveBeenCalledWith(
          messageId,
          "fixed",
        );
        expect(notifications.retractChatMessage).not.toHaveBeenCalled();
      });

      it("leaves the rows alone when the message is unchanged", async () => {
        tournament.roster = [ME, FRIEND];
        redis.hset.mockImplementationOnce(
          async (key: string, field: string, raw: string) => {
            stored[key] = { [field]: raw };
          },
        );

        await say(ChatLobbyType.Tournament, "t-1");
        await flush();
        await flush();

        expect(notifications.notifyPlayers).toHaveBeenCalled();
        expect(notifications.updateChatMessagePreview).not.toHaveBeenCalled();
        expect(notifications.retractChatMessage).not.toHaveBeenCalled();
      });

      it("retracts them when a direct message was deleted meanwhile", async () => {
        const room = directRoomId(ME, FRIEND);
        notifications.notifyPlayers.mockImplementationOnce(async () => {
          const insert = queries.find(({ sql }) =>
            sql.includes("INSERT INTO public.direct_messages"),
          );
          directMessage = {
            id: insert.bindings[0],
            roomId: room,
            author: ME,
            message: "typo",
            open: true,
            editedAt: null,
          };

          await expect(
            service.deleteMessage(
              ChatLobbyType.Direct,
              room,
              insert.bindings[0],
              me(),
            ),
          ).resolves.toEqual({ deleted: true });
        });

        const messageId = await say(ChatLobbyType.Direct, room);
        await flush();
        await flush();

        expect(notifications.retractChatMessage).toHaveBeenCalledTimes(2);
        expect(notifications.retractChatMessage).toHaveBeenLastCalledWith(
          messageId,
        );
        expect(
          notifications.retractChatMessage.mock.invocationCallOrder[1],
        ).toBeGreaterThan(
          notifications.collapseOlderUnread.mock.invocationCallOrder[0],
        );
      });

      it("gives them a direct message's edited text", async () => {
        notifications.notifyPlayers.mockImplementationOnce(async () => {
          const insert = queries.find(({ sql }) =>
            sql.includes("INSERT INTO public.direct_messages"),
          );
          directMessage = {
            id: insert.bindings[0],
            roomId: insert.bindings[1],
            author: ME,
            message: "fixed",
            open: true,
            editedAt: new Date(),
          };
        });

        const messageId = await say(
          ChatLobbyType.Direct,
          directRoomId(ME, FRIEND),
        );
        await flush();
        await flush();

        expect(notifications.updateChatMessagePreview).toHaveBeenCalledWith(
          messageId,
          "fixed",
        );
        expect(notifications.retractChatMessage).not.toHaveBeenCalled();
      });
    });
  });

  describe("reactions", () => {
    const MESSAGE_ID = "7b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
    const ROOM = "chat_match_m-1";
    const REACTIONS = "chat_reactions_match_m-1";

    let hashes: Record<string, Record<string, string>>;
    let rates: Record<string, number>;
    let receipts: Set<string>;

    const as = (steamId: string, overrides: Record<string, unknown> = {}) =>
      ({
        steam_id: steamId,
        name: "Someone",
        role: "user",
        ...overrides,
      }) as any;

    const react = (
      reaction: unknown = "heart",
      user = as(ME),
      type = ChatLobbyType.Match,
      id = "m-1",
      messageId = MESSAGE_ID,
    ) => service.toggleReaction(type, id, messageId, reaction, user);

    const broadcasts = (event: string) =>
      redis.publish.mock.calls
        .map(([, payload]) => JSON.parse(payload))
        .filter((published) => published.event === event);

    const toggles = () =>
      redis.eval.mock.calls.filter(([script]) => script.includes("cjson"));

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      rates = {};
      receipts = new Set();
      hashes = {
        [ROOM]: {
          [MESSAGE_ID]: JSON.stringify({
            id: MESSAGE_ID,
            message: "gg",
            timestamp: new Date().toISOString(),
            source: "web",
            from: { role: "user", name: "Friend", steam_id: FRIEND },
          }),
        },
      };

      // Everyone asked about is seated in the room; who may be in it at all
      // is the joining tests' subject.
      redis.hget.mockImplementation(async (key: string, field: string) => {
        if (key.startsWith("chat:")) {
          return JSON.stringify({ user: { steam_id: field } });
        }
        return hashes[key]?.[field] ?? null;
      });
      redis.hgetall.mockImplementation(async (key: string) => {
        if (key === "chat:match:m-1") {
          return { [FRIEND]: JSON.stringify({ user: { steam_id: FRIEND } }) };
        }
        return { ...hashes[key] };
      });
      redis.hdel.mockImplementation(async (key: string, field: string) => {
        delete hashes[key]?.[field];
        return 1;
      });
      redis.eval.mockImplementation(
        async (script: string, _keys: number, ...args: any[]) => {
          if (script.includes("INCR")) {
            const [key] = args;
            rates[key] = (rates[key] ?? 0) + 1;
            return rates[key];
          }

          if (script.includes("cjson")) {
            const [
              roomKey,
              reactionsKey,
              receipt,
              messageId,
              reaction,
              steamId,
              removeOnly,
            ] = args;

            if (receipts.has(receipt)) {
              return hashes[reactionsKey]?.[messageId] ?? "{}";
            }

            if (!hashes[roomKey]?.[messageId]) {
              return null;
            }

            const state = JSON.parse(hashes[reactionsKey]?.[messageId] ?? "{}");
            const holders: string[] = state[reaction] ?? [];

            if (!holders.includes(steamId) && removeOnly === "1") {
              return 0;
            }

            receipts.add(receipt);
            state[reaction] = holders.includes(steamId)
              ? holders.filter((holder) => holder !== steamId)
              : [...holders, steamId];
            if (state[reaction].length === 0) {
              delete state[reaction];
            }

            hashes[reactionsKey] = {
              ...hashes[reactionsKey],
              [messageId]: JSON.stringify(state),
            };
            return JSON.stringify(state);
          }

          return [1, 1];
        },
      );
    });

    it("toggles a reaction on and then off", async () => {
      await expect(react()).resolves.toEqual({
        toggled: true,
        reactions: { heart: [ME] },
      });
      await expect(react()).resolves.toEqual({
        toggled: true,
        reactions: {},
      });
    });

    it("sends the room the message's whole reaction state", async () => {
      await react("heart", as(FRIEND));
      await react("fire", as(FRIEND));
      await react("heart");
      await flush();

      expect(broadcasts("lobby:match:m-1:reaction").at(-1)).toEqual({
        steamId: FRIEND,
        event: "lobby:match:m-1:reaction",
        data: {
          id: MESSAGE_ID,
          reactions: { heart: [FRIEND, ME], fire: [FRIEND] },
        },
      });
    });

    it("hands the toggle both hashes, a receipt of its own and who reacted", async () => {
      await react("laugh");
      await react("laugh");

      const [first, second] = toggles();

      expect(first.slice(1)).toEqual([
        3,
        ROOM,
        REACTIONS,
        expect.stringMatching(/^chat_reaction_applied:[0-9a-f-]{36}$/),
        MESSAGE_ID,
        "laugh",
        ME,
        "0",
        300_000,
      ]);
      expect(second[4]).not.toBe(first[4]);
    });

    it("orders reactions as the list does, whatever order they were stored in", async () => {
      await react("sad");
      await react("fire", as(FRIEND));

      const result = await react("thumbsup");

      expect(Object.keys(result.toggled ? result.reactions : {})).toEqual([
        "thumbsup",
        "fire",
        "sad",
      ]);
    });

    it("accepts every reaction on the list", async () => {
      for (const reaction of ChatService.REACTIONS) {
        // The list is longer than a second's allowance; the limit has its own
        // tests.
        rates = {};
        await expect(react(reaction)).resolves.toMatchObject({
          toggled: true,
        });
      }

      expect(ChatService.REACTIONS).toEqual([
        "thumbsup",
        "heart",
        "laugh",
        "fire",
        "wow",
        "sad",
        "thumbsdown",
        "skull",
        "sob",
        "rofl",
        "angry",
        "thinking",
        "eyes",
        "hundred",
        "target",
        "clap",
        "pray",
        "handshake",
        "tada",
        "cool",
        "salute",
        "muscle",
        "goat",
        "clown",
      ]);
    });

    it.each([
      ["one that is not on the list", "party"],
      ["a different case", "HEART"],
      ["an object key", "__proto__"],
      ["an empty string", ""],
      ["a number", 5],
      ["null", null],
    ])("refuses %s as invalid before anything else", async (_, reaction) => {
      await expect(react(reaction)).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.Invalid,
      });

      expect(redis.eval).not.toHaveBeenCalled();
      expect(hashes[REACTIONS]).toBeUndefined();
    });

    it("answers not_found for an id that could never be a message", async () => {
      await expect(
        react("heart", as(ME), ChatLobbyType.Match, "m-1", "not-a-uuid"),
      ).resolves.toEqual({ toggled: false, code: ChatErrorCode.NotFound });
      expect(toggles()).toHaveLength(0);
    });

    it("gives a message that is gone no reactions", async () => {
      delete hashes[ROOM][MESSAGE_ID];

      await expect(react()).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.NotFound,
      });
      await flush();

      expect(hashes[REACTIONS]).toBeUndefined();
      expect(broadcasts("lobby:match:m-1:reaction")).toEqual([]);
    });

    it("refuses someone who cannot get into the room", async () => {
      hashes["chat_match_m-2"] = hashes[ROOM];

      await expect(
        react("heart", as(ME), ChatLobbyType.Match, "m-2"),
      ).resolves.toEqual({ toggled: false, code: ChatErrorCode.NotAllowed });
      expect(toggles()).toHaveLength(0);
    });

    it("refuses someone who is not in the room", async () => {
      redis.hget.mockImplementation(async (key: string, field: string) =>
        key.startsWith("chat:") ? null : (hashes[key]?.[field] ?? null),
      );

      await expect(react()).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.NotAllowed,
      });
      expect(toggles()).toHaveLength(0);
    });

    it("keeps a gagged player from adding a reaction in a group room", async () => {
      gagged = true;

      await expect(react()).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.Gagged,
      });
      await flush();

      expect(toggles()[0][8]).toBe("1");
      expect(hashes[REACTIONS]).toBeUndefined();
      expect(broadcasts("lobby:match:m-1:reaction")).toEqual([]);
    });

    it("lets a gagged player take back a reaction they already gave", async () => {
      await react("heart");
      gagged = true;

      await expect(react("heart")).resolves.toEqual({
        toggled: true,
        reactions: {},
      });
    });

    it("lets through eight toggles a second and refuses the ninth", async () => {
      for (let toggle = 0; toggle < ChatService.REACTION_RATE_LIMIT; toggle++) {
        await expect(react()).resolves.toMatchObject({ toggled: true });
      }

      await expect(react()).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.RateLimited,
      });
      await flush();

      expect(toggles()).toHaveLength(ChatService.REACTION_RATE_LIMIT);
      expect(broadcasts("lobby:match:m-1:reaction")).toHaveLength(
        ChatService.REACTION_RATE_LIMIT,
      );
      await expect(react("heart", as(FRIEND))).resolves.toMatchObject({
        toggled: true,
      });
    });

    it("counts toggles per player, in a window that starts with the first", async () => {
      await react();

      const rate = redis.eval.mock.calls.find(([script]) =>
        script.includes("INCR"),
      );

      expect(rate.slice(1)).toEqual([1, `chat:reaction-rate:${ME}`, 1_000]);
      expect(rate[0]).toContain("PEXPIRE");
    });

    it("never notifies anyone or relays to the game", async () => {
      await react();
      await flush();

      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
      expect(rcon.connect).not.toHaveBeenCalled();
      expect(broadcasts("lobby:match:m-1:chat")).toEqual([]);
    });

    it("clears a message's reactions when it is deleted", async () => {
      await react();
      role = "moderator";

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          as(ME, { role: "moderator" }),
        ),
      ).resolves.toEqual({ deleted: true });

      expect(redis.hdel).toHaveBeenCalledWith(REACTIONS, MESSAGE_ID);
      expect(hashes[REACTIONS][MESSAGE_ID]).toBeUndefined();
    });

    it("clears a message's reactions when its author deletes it", async () => {
      hashes[ROOM][MESSAGE_ID] = JSON.stringify({
        ...JSON.parse(hashes[ROOM][MESSAGE_ID]),
        from: { role: "user", name: "Me", steam_id: ME },
      });
      await react("heart", as(FRIEND));

      await expect(
        service.deleteMessage(ChatLobbyType.Match, "m-1", MESSAGE_ID, as(ME)),
      ).resolves.toEqual({ deleted: true });

      expect(hashes[REACTIONS][MESSAGE_ID]).toBeUndefined();
    });

    it("still announces a delete when its reactions cannot be cleared", async () => {
      await react();
      role = "moderator";
      redis.hdel.mockImplementation(async (key: string, field: string) => {
        if (key === REACTIONS) {
          throw new Error("connection reset");
        }
        delete hashes[key]?.[field];
        return 1;
      });

      await expect(
        service.deleteMessage(
          ChatLobbyType.Match,
          "m-1",
          MESSAGE_ID,
          as(ME, { role: "moderator" }),
        ),
      ).resolves.toEqual({ deleted: true });
      await flush();

      expect(broadcasts("lobby:match:m-1:deleted")).toHaveLength(1);
      expect(notifications.retractChatMessage).toHaveBeenCalledWith(MESSAGE_ID);
    });

    it("puts each message's reactions in the room's history", async () => {
      const quiet = "8c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f";
      hashes[ROOM][quiet] = JSON.stringify({
        id: quiet,
        message: "later",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        source: "web",
        from: { role: "user", name: "Friend", steam_id: FRIEND },
      });
      await react("fire");

      const history = await service["getMessages"](ChatLobbyType.Match, "m-1");

      expect(
        history.map(({ id, reactions }: any) => ({ id, reactions })),
      ).toEqual([
        { id: MESSAGE_ID, reactions: { fire: [ME] } },
        { id: quiet, reactions: {} },
      ]);
    });

    it("sends a new message out with no reactions, and stores none", async () => {
      await service.sendMessageToChat(ChatLobbyType.Match, "m-1", as(ME), "hi");
      await flush();

      const [chat] = broadcasts("lobby:match:m-1:chat");
      const stored = JSON.parse(
        redis.hset.mock.calls.find(([key]) => key === ROOM)[2],
      );

      expect(chat.data.reactions).toEqual({});
      expect(stored).not.toHaveProperty("reactions");
    });

    // The move itself is a Lua script, exercised against real redis in
    // test/chat-redis-actions.spec.ts; this is what the service does around it.
    it("hands the move all four keys, then re-sends history with the reactions it carried", async () => {
      hashes[REACTIONS] = { [MESSAGE_ID]: JSON.stringify({ fire: [ME] }) };
      redis.eval.mockResolvedValueOnce(1);

      await service.migrateLobbyMessages(
        ChatLobbyType.Draft,
        "d-1",
        ChatLobbyType.Match,
        "m-1",
      );
      await flush();

      const move = redis.eval.mock.calls.find(([script]) =>
        script.includes("HGETALL"),
      );

      expect(move.slice(1)).toEqual([
        4,
        "chat_draft_d-1",
        ROOM,
        "chat_reactions_draft_d-1",
        REACTIONS,
        3600,
      ]);
      expect(broadcasts("lobby:match:m-1:messages")).toEqual([
        expect.objectContaining({
          data: {
            id: "m-1",
            messages: [
              expect.objectContaining({
                id: MESSAGE_ID,
                reactions: { fire: [ME] },
              }),
            ],
          },
        }),
      ]);
    });

    describe("in a direct conversation", () => {
      const room = directRoomId(ME, FRIEND);

      const reactDirect = (reaction = "heart", user = as(ME)) =>
        react(reaction, user, ChatLobbyType.Direct, room);

      beforeEach(() => {
        directMessage = {
          id: MESSAGE_ID,
          roomId: room,
          author: FRIEND,
          message: "gg",
          open: true,
          editedAt: null,
        };
        directReactions = { heart: [ME] };
        redis.hgetall.mockImplementation(async (key: string) =>
          key === `chat:direct:${room}`
            ? { [FRIEND]: JSON.stringify({ user: { steam_id: FRIEND } }) }
            : {},
        );
      });

      it("locks the message, toggles in one statement scoped to the conversation, then reads the state", async () => {
        await expect(reactDirect()).resolves.toEqual({
          toggled: true,
          reactions: { heart: [ME] },
        });
        await flush();

        const lock = queries.findIndex(({ sql }) =>
          sql.includes("FOR NO KEY UPDATE"),
        );
        const toggleAt = queries.findIndex(({ sql }) =>
          sql.includes("INSERT INTO public.direct_message_reactions"),
        );
        const toggle = queries[toggleAt];

        expect(postgres.transaction).toHaveBeenCalledTimes(1);
        expect(queries[lock].bindings).toEqual([MESSAGE_ID, room]);
        expect(lock).toBeLessThan(toggleAt);
        expect(toggle.bindings).toEqual([MESSAGE_ID, ME, "heart", room]);
        expect(toggle.sql).toContain(
          "DELETE FROM public.direct_message_reactions",
        );
        expect(broadcasts(`lobby:direct:${room}:reaction`)).toEqual([
          {
            steamId: FRIEND,
            event: `lobby:direct:${room}:reaction`,
            data: { id: MESSAGE_ID, reactions: { heart: [ME] } },
          },
        ]);
      });

      it("answers with an empty state once the last reaction is gone", async () => {
        directReactions = null;

        await expect(reactDirect()).resolves.toEqual({
          toggled: true,
          reactions: {},
        });
      });

      it("is not held back by a gag", async () => {
        gagged = true;

        await expect(reactDirect()).resolves.toMatchObject({ toggled: true });
        expect(
          queries.some(({ sql }) => sql.includes("public.is_gagged")),
        ).toBe(false);
      });

      it("refuses once the friendship is gone", async () => {
        acceptedFriendships = [];

        await expect(reactDirect()).resolves.toEqual({
          toggled: false,
          code: ChatErrorCode.NotAllowed,
        });
        expect(
          queries.some(({ sql }) => sql.includes("direct_message_reactions")),
        ).toBe(false);
      });

      it("answers not_found for a message that is not in the conversation", async () => {
        directMessage = {
          ...directMessage,
          roomId: directRoomId(FRIEND, STRANGER),
        };

        await expect(reactDirect()).resolves.toEqual({
          toggled: false,
          code: ChatErrorCode.NotFound,
        });
        await flush();

        expect(
          queries.some(({ sql }) =>
            sql.includes("INSERT INTO public.direct_message_reactions"),
          ),
        ).toBe(false);
        expect(broadcasts(`lobby:direct:${room}:reaction`)).toEqual([]);
      });

      it("orders reactions as the list does", async () => {
        directReactions = { sad: [FRIEND], heart: [ME], thumbsup: [FRIEND] };

        const result = await reactDirect();

        expect(Object.keys(result.toggled ? result.reactions : {})).toEqual([
          "thumbsup",
          "heart",
          "sad",
        ]);
      });

      it("lets any other failure through", async () => {
        directReactionFailure = new Error("database down");

        await expect(reactDirect()).rejects.toThrow("database down");
      });

      it("puts reactions in the conversation's history", async () => {
        postgres.query.mockResolvedValueOnce([
          {
            id: "dm-1",
            message: "old",
            created_at: new Date("2026-01-01T00:00:00Z"),
            reactions: { heart: [FRIEND] },
            steam_id: ME,
            name: "Someone",
            role: "user",
            avatar_url: null,
            profile_url: null,
          },
          {
            id: "dm-2",
            message: "older",
            created_at: new Date("2025-12-31T00:00:00Z"),
            reactions: null,
            steam_id: ME,
            name: "Someone",
            role: "user",
            avatar_url: null,
            profile_url: null,
          },
        ]);

        const history = await service["getDirectMessages"](room);

        expect(
          history.map(({ id, reactions }: any) => ({ id, reactions })),
        ).toEqual([
          { id: "dm-2", reactions: {} },
          { id: "dm-1", reactions: { heart: [FRIEND] } },
        ]);
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

  describe("blocking", () => {
    const MESSAGE_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    const room = directRoomId(ME, FRIEND);

    let seated: string[];
    let hashes: Record<string, Record<string, string>>;
    let lines: number;

    const as = (steamId: string) =>
      ({
        steam_id: steamId,
        name: "Someone",
        role: "user",
        avatar_url: null,
        profile_url: null,
      }) as any;

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const published = () =>
      redis.publish.mock.calls.map(([, payload]) => JSON.parse(payload));

    const recipientsOf = (event: string) =>
      published()
        .filter((sent) => sent.event === event)
        .map((sent) => sent.steamId)
        .sort();

    const say = (from: string, message: string, id = `line-${++lines}`) => {
      hashes["chat_match_m-1"] ??= {};
      hashes["chat_match_m-1"][id] = JSON.stringify({
        id,
        message,
        timestamp: new Date(Date.now() - 60_000 + lines * 1_000).toISOString(),
        source: "web",
        from: { role: "user", name: "Someone", steam_id: from },
      });
      return id;
    };

    beforeEach(() => {
      seated = [ME, FRIEND, STRANGER];
      hashes = {};
      lines = 0;

      redis.hgetall.mockImplementation(async (key: string) => {
        if (key.startsWith("chat:")) {
          return Object.fromEntries(
            seated.map((steamId) => [
              steamId,
              JSON.stringify({ user: { steam_id: steamId } }),
            ]),
          );
        }
        return { ...hashes[key] };
      });
      redis.hget.mockImplementation(async (key: string, field: string) => {
        if (key.startsWith("chat:")) {
          return seated.includes(field)
            ? JSON.stringify({ user: { steam_id: field } })
            : null;
        }
        return hashes[key]?.[field] ?? null;
      });
      redis.hset.mockImplementation(
        async (key: string, field: string, value: string) => {
          hashes[key] ??= {};
          hashes[key][field] = value;
          return 1;
        },
      );
      redis.hdel.mockImplementation(async (key: string, field: string) => {
        delete hashes[key]?.[field];
        return 1;
      });
    });

    describe.each([
      ["the player blocked their friend", ME, FRIEND],
      ["their friend blocked the player", FRIEND, ME],
    ])("a direct conversation once %s", (_, blocker, blocked) => {
      beforeEach(() => {
        // The block deletes the friendship in the database. It is left in
        // place here so the block is the only thing refusing.
        blocks = [[blocker, blocked]];
      });

      it.each([ME, FRIEND])("keeps %s from joining", async (steamId) => {
        await service.joinMatchLobby(
          client(steamId),
          ChatLobbyType.Direct,
          room,
        );

        expect(redis.eval).not.toHaveBeenCalled();
      });

      it.each([ME, FRIEND])("refuses a message from %s", async (steamId) => {
        await expect(
          service.sendMessageToChat(
            ChatLobbyType.Direct,
            room,
            as(steamId),
            "still there?",
          ),
        ).resolves.toEqual({
          accepted: false,
          code: ChatErrorCode.NotAllowed,
        });

        expect(
          queries.some(({ sql }) =>
            sql.includes("INSERT INTO public.direct_messages"),
          ),
        ).toBe(false);
        expect(redis.publish).not.toHaveBeenCalled();
      });

      it.each([ME, FRIEND])(
        "refuses %s editing their own message",
        async (steamId) => {
          directMessage = {
            id: MESSAGE_ID,
            roomId: room,
            author: steamId,
            message: "typo",
            open: true,
            editedAt: null,
          };

          await expect(
            service.editMessage(
              ChatLobbyType.Direct,
              room,
              MESSAGE_ID,
              as(steamId),
              "fixed",
            ),
          ).resolves.toEqual({
            edited: false,
            code: ChatErrorCode.NotAllowed,
          });

          expect(directMessage.message).toBe("typo");
          expect(redis.publish).not.toHaveBeenCalled();
        },
      );

      it.each([ME, FRIEND])("refuses %s reacting", async (steamId) => {
        directMessage = {
          id: MESSAGE_ID,
          roomId: room,
          author: steamId === ME ? FRIEND : ME,
          message: "gg",
          open: true,
          editedAt: null,
        };
        redis.eval.mockResolvedValue(1);

        await expect(
          service.toggleReaction(
            ChatLobbyType.Direct,
            room,
            MESSAGE_ID,
            "heart",
            as(steamId),
          ),
        ).resolves.toEqual({ toggled: false, code: ChatErrorCode.NotAllowed });

        expect(
          queries.some(({ sql }) =>
            sql.includes("INSERT INTO public.direct_message_reactions"),
          ),
        ).toBe(false);
        expect(redis.publish).not.toHaveBeenCalled();
      });

      it.each([ME, FRIEND])(
        "keeps %s from marking it read",
        async (steamId) => {
          await expect(
            service.markThreadRead(ChatLobbyType.Direct, room, as(steamId)),
          ).resolves.toBeNull();

          expect(
            queries.some(({ sql }) => sql.includes("chat_read_state")),
          ).toBe(false);
        },
      );

      it.each([ME, FRIEND])(
        "refuses %s deleting their own message",
        async (steamId) => {
          directMessage = {
            id: MESSAGE_ID,
            roomId: room,
            author: steamId,
            message: "typo",
            open: true,
            editedAt: null,
          };

          await expect(
            service.deleteMessage(
              ChatLobbyType.Direct,
              room,
              MESSAGE_ID,
              as(steamId),
            ),
          ).resolves.toEqual({
            deleted: false,
            code: ChatErrorCode.NotAllowed,
          });

          expect(directMessage).toBeDefined();
          expect(redis.publish).not.toHaveBeenCalled();
        },
      );
    });

    it("refuses the pair's conversation under any id but the canonical one", async () => {
      const [low, high] = room.split(":");

      for (const id of [`${high}:${low}`, `${low}:0${high}`]) {
        await service.joinMatchLobby(client(ME), ChatLobbyType.Direct, id);

        await expect(
          service.sendMessageToChat(ChatLobbyType.Direct, id, as(ME), "hi"),
        ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });
      }

      expect(
        redis.eval.mock.calls.filter(([script]) => !script.includes("INCR")),
      ).toEqual([]);
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("stores, delivers and announces nothing when a block lands between the check and the insert", async () => {
      dmInsertBlocked = true;

      await expect(
        service.sendMessageToChat(ChatLobbyType.Direct, room, as(ME), "hi"),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });
      await flush();

      const [insert] = queries.filter(({ sql }) =>
        sql.includes("INSERT INTO public.direct_messages"),
      );

      expect(insert.sql).toContain("WHERE NOT public.is_blocked_either_way(");
      expect(
        queries.some(({ sql }) =>
          sql.includes("INSERT INTO public.direct_conversations"),
        ),
      ).toBe(false);
      expect(redis.publish).not.toHaveBeenCalled();
      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("keeps a direct message from a player its recipient has just blocked", async () => {
      blocks = [[FRIEND, ME]];
      playerBlocks.isBlockedEitherWay.mockResolvedValueOnce(false);

      await expect(
        service.sendMessageToChat(ChatLobbyType.Direct, room, as(ME), "hi"),
      ).resolves.toMatchObject({ accepted: true });
      await flush();
      await flush();

      expect(published().map(({ steamId }) => steamId)).not.toContain(FRIEND);
      expect(playerBlocks.hasBlocked).toHaveBeenCalledWith(FRIEND, ME);
      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("keeps the socket's cleanup when the history's block lookup fails", async () => {
      const socket = client(ME);
      playerBlocks.blockedBy.mockRejectedValueOnce(new Error("pool timeout"));

      await expect(
        service.joinMatchLobby(socket, ChatLobbyType.Match, "m-1"),
      ).rejects.toThrow("pool timeout");

      expect(redis.eval).toHaveBeenCalled();
      expect(socket.on).toHaveBeenCalledWith("close", expect.any(Function));
    });

    it("lets the same pair back into their conversation once unblocked", async () => {
      await service.joinMatchLobby(client(ME), ChatLobbyType.Direct, room);

      expect(redis.eval).toHaveBeenCalled();
      expect(playerBlocks.isBlockedEitherWay).toHaveBeenCalledWith(ME, FRIEND);
    });

    describe("history", () => {
      const historyOf = async (steamId: string) => {
        const socket = client(steamId);

        await service.joinMatchLobby(socket, ChatLobbyType.Match, "m-1");

        const sent = socket.send.mock.calls
          .map(([payload]: [string]) => JSON.parse(payload))
          .find(({ event }: any) => event === "lobby:match:m-1:messages");

        return sent.data.messages.map(({ message }: any) => message);
      };

      it("leaves out what the viewer blocked, for the viewer only", async () => {
        say(FRIEND, "from friend");
        say(STRANGER, "from stranger");
        say(ME, "from me");
        blocks = [[ME, FRIEND]];

        expect(await historyOf(ME)).toEqual(["from stranger", "from me"]);
        expect(await historyOf(FRIEND)).toEqual([
          "from friend",
          "from stranger",
          "from me",
        ]);
        expect(await historyOf(STRANGER)).toEqual([
          "from friend",
          "from stranger",
          "from me",
        ]);
        expect(playerBlocks.blockedBy).toHaveBeenCalledWith(ME, MODERATORS);
      });

      it("hides nothing from the player a block is aimed at", async () => {
        say(FRIEND, "from friend");
        blocks = [[FRIEND, ME]];

        expect(await historyOf(ME)).toEqual(["from friend"]);
      });

      it("re-sends a moved draft's history to each player without what they blocked", async () => {
        say(FRIEND, "from friend");
        say(STRANGER, "from stranger");
        blocks = [[ME, FRIEND]];
        redis.eval.mockResolvedValueOnce(2);

        await service.migrateLobbyMessages(
          ChatLobbyType.Draft,
          "d-1",
          ChatLobbyType.Match,
          "m-1",
        );
        await flush();

        const resent = Object.fromEntries(
          published()
            .filter(({ event }) => event === "lobby:match:m-1:messages")
            .map(({ steamId, data }) => [
              steamId,
              data.messages.map(({ message }: any) => message),
            ]),
        );

        expect(resent).toEqual({
          [ME]: ["from stranger"],
          [FRIEND]: ["from friend", "from stranger"],
          [STRANGER]: ["from friend", "from stranger"],
        });
        expect(playerBlocks.blockedAmong).toHaveBeenCalledTimes(1);
        expect(playerBlocks.blockedAmong).toHaveBeenCalledWith(
          [ME, FRIEND, STRANGER],
          [FRIEND, STRANGER],
          MODERATORS,
        );
      });

      it("logs a re-send whose block lookup fails instead of leaving it unhandled", async () => {
        say(FRIEND, "from friend");
        redis.eval.mockResolvedValueOnce(1);
        playerBlocks.blockedAmong.mockRejectedValueOnce(
          new Error("pool timeout"),
        );

        await service.migrateLobbyMessages(
          ChatLobbyType.Draft,
          "d-1",
          ChatLobbyType.Match,
          "m-1",
        );
        await flush();

        expect(logger.warn).toHaveBeenCalledWith(
          "unable to re-send history to match:m-1",
          expect.any(Error),
        );
      });
    });

    describe("live", () => {
      beforeEach(() => {
        redis.eval.mockImplementation(async (script: string) => {
          if (script.includes("INCR")) {
            return 1;
          }
          if (script.includes("cjson")) {
            return JSON.stringify({ heart: [STRANGER] });
          }
          return 1;
        });
      });

      it("never sends a line or its edit to a player who blocked its author", async () => {
        blocks = [[ME, FRIEND]];

        const sent = await service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          as(FRIEND),
          "hello",
        );
        await flush();

        expect(recipientsOf("lobby:match:m-1:chat")).toEqual(
          [FRIEND, STRANGER].sort(),
        );
        expect(playerBlocks.blockedAmong).toHaveBeenCalledWith(
          [ME, FRIEND, STRANGER],
          [FRIEND],
          MODERATORS,
        );

        await expect(
          service.editMessage(
            ChatLobbyType.Match,
            "m-1",
            sent.accepted ? sent.messageId : "",
            as(FRIEND),
            "hello again",
          ),
        ).resolves.toMatchObject({ edited: true });
        await flush();

        expect(recipientsOf("lobby:match:m-1:edited")).toEqual(
          [FRIEND, STRANGER].sort(),
        );
      });

      it("logs a line or edit whose broadcast fails instead of leaving it unhandled", async () => {
        jest.spyOn(service, "to").mockRejectedValue(new Error("pool timeout"));

        const sent = await service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          as(FRIEND),
          "hello",
        );
        await flush();

        await expect(
          service.editMessage(
            ChatLobbyType.Match,
            "m-1",
            sent.accepted ? sent.messageId : "",
            as(FRIEND),
            "hello again",
          ),
        ).resolves.toMatchObject({ edited: true });
        await flush();

        expect(sent).toMatchObject({ accepted: true });
        expect(logger.warn).toHaveBeenCalledWith(
          "unable to broadcast a message to match:m-1",
          expect.any(Error),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "unable to broadcast an edit to match:m-1",
          expect.any(Error),
        );
      });

      it("logs a reaction whose block lookup fails instead of leaving it unhandled", async () => {
        const id = say(FRIEND, "hello", MESSAGE_ID);
        playerBlocks.blockedAmong.mockRejectedValueOnce(
          new Error("pool timeout"),
        );

        await expect(
          service.toggleReaction(
            ChatLobbyType.Match,
            "m-1",
            id,
            "heart",
            as(ME),
          ),
        ).resolves.toMatchObject({ toggled: true });
        await flush();

        expect(logger.warn).toHaveBeenCalledWith(
          "unable to broadcast a reaction to match:m-1",
          expect.any(Error),
        );
      });

      it("publishes a room's reaction updates in the order they were applied", async () => {
        const id = say(FRIEND, "hello", MESSAGE_ID);
        const states = [{ heart: [ME] }, { heart: [ME, STRANGER] }];
        redis.eval.mockImplementation(async (script: string) => {
          if (script.includes("cjson")) {
            return JSON.stringify(states.shift());
          }
          return 1;
        });
        let releaseFirst = () => undefined;
        playerBlocks.blockedAmong.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = () => resolve(new Map());
            }),
        );

        for (const reactor of [ME, STRANGER]) {
          await service.toggleReaction(
            ChatLobbyType.Match,
            "m-1",
            id,
            "heart",
            as(reactor),
          );
        }
        await flush();
        releaseFirst();
        await flush();
        await flush();

        expect(
          published()
            .filter(
              ({ event, steamId }) =>
                event === "lobby:match:m-1:reaction" && steamId === FRIEND,
            )
            .map(({ data }) => data.reactions),
        ).toEqual([{ heart: [ME] }, { heart: [ME, STRANGER] }]);
      });

      it("strips a blocked reactor from the blocker's reaction update only", async () => {
        blocks = [[ME, STRANGER]];
        const id = say(FRIEND, "hello", MESSAGE_ID);

        await service.toggleReaction(
          ChatLobbyType.Match,
          "m-1",
          id,
          "heart",
          as(FRIEND),
        );
        await flush();

        const sent = Object.fromEntries(
          published()
            .filter(({ event }) => event === "lobby:match:m-1:reaction")
            .map(({ steamId, data }) => [steamId, data.reactions]),
        );

        expect(sent).toEqual({
          [ME]: {},
          [FRIEND]: { heart: [STRANGER] },
          [STRANGER]: { heart: [STRANGER] },
        });
        expect(playerBlocks.blockedAmong).toHaveBeenCalledWith(
          [ME, FRIEND, STRANGER],
          [STRANGER],
          MODERATORS,
        );
      });

      it("still sends the blocker's own lines to the player they blocked", async () => {
        blocks = [[ME, FRIEND]];

        await service.sendMessageToChat(
          ChatLobbyType.Match,
          "m-1",
          as(ME),
          "hello",
        );
        await flush();

        expect(recipientsOf("lobby:match:m-1:chat")).toEqual(
          [ME, FRIEND, STRANGER].sort(),
        );
      });

      it("sends a hidden line's delete and reactions to everyone, with nothing in them to read", async () => {
        blocks = [[ME, FRIEND]];
        const id = say(FRIEND, "hidden", MESSAGE_ID);

        await service.toggleReaction(
          ChatLobbyType.Match,
          "m-1",
          id,
          "heart",
          as(STRANGER),
        );

        await service.deleteMessage(ChatLobbyType.Match, "m-1", id, as(FRIEND));
        await flush();

        for (const event of ["reaction", "deleted"]) {
          const sent = published().filter(
            (published) => published.event === `lobby:match:m-1:${event}`,
          );

          expect(sent.map(({ steamId }) => steamId).sort()).toEqual(
            [ME, FRIEND, STRANGER].sort(),
          );

          for (const { data } of sent) {
            expect(JSON.stringify(data)).not.toContain("hidden");
            expect(Object.keys(data).sort()).toEqual(
              event === "reaction" ? ["id", "reactions"] : ["id"],
            );
          }
        }
      });
    });

    describe("notifications", () => {
      const sayInTournament = async (from: string) => {
        tournament.roster = [ME, FRIEND, STRANGER];

        const result = await service.sendMessageToChat(
          ChatLobbyType.Tournament,
          "t-1",
          as(from),
          "hello",
        );

        await flush();
        await flush();

        return result.accepted ? result.messageId : undefined;
      };

      it("writes none for a player who blocked the sender", async () => {
        blocks = [[ME, FRIEND]];

        await sayInTournament(FRIEND);

        expect(notifications.notifyPlayers).toHaveBeenCalledWith(
          "ChatMessage",
          expect.objectContaining({ steamIds: [STRANGER] }),
        );
        expect(notifications.collapseOlderUnread).toHaveBeenCalledWith(
          "ChatMessage",
          "tournament:t-1",
          [STRANGER],
        );
      });

      it("writes none at all when everyone else blocked the sender", async () => {
        blocks = [
          [ME, FRIEND],
          [STRANGER, FRIEND],
        ];

        await sayInTournament(FRIEND);

        expect(playerBlocks.blockedAmong).toHaveBeenCalledWith(
          [STRANGER, ME],
          [FRIEND],
          MODERATORS,
        );
        expect(notifications.notifyPlayers).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it("catches up on a block that landed while the rows were being written", async () => {
        const messageId = await sayInTournament(FRIEND);

        expect(
          notifications.retractChatMessageFromBlocked,
        ).toHaveBeenCalledWith(messageId, MODERATORS);
        expect(
          notifications.retractChatMessageFromBlocked.mock
            .invocationCallOrder[0],
        ).toBeGreaterThan(
          notifications.notifyPlayers.mock.invocationCallOrder[0],
        );
      });

      it("still notifies the player a block is aimed at", async () => {
        blocks = [[FRIEND, ME]];

        await sayInTournament(FRIEND);

        expect(
          notifications.notifyPlayers.mock.calls[0][1].steamIds.sort(),
        ).toEqual([ME, STRANGER].sort());
      });
    });

    it("asks the rail for the caller's own blocks only", async () => {
      await service.getDirectConversations(as(ME));

      const [rail] = queries.filter(({ sql }) =>
        sql.includes("FROM public.direct_conversations dc"),
      );

      expect(rail.bindings).toEqual([ME]);
      expect(rail.sql).toMatch(
        /NOT EXISTS \([\s\S]*public\.player_blocks pb[\s\S]*pb\.blocker_steam_id = dc\.steam_id/,
      );
      expect(rail.sql).not.toContain("pb.blocked_steam_id = dc.steam_id");
    });
  });
});
