import { ChatService } from "./chat.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { directRoomId } from "./utilities/directRoomId";

const VEXX = "76561198000000001";
const KAIRO = "76561198000000002";
const KASPR = "76561198000000003";
const ZED = "76561198000000004";
const OKAMI = "76561198000000005";
const MARLOWE = "76561198000000006";
const BIG = "76561198000000007";
const BIG_BOB = "76561198000000008";
const FILLER = Array.from(
  { length: 12 },
  (_, index) => `7656119800000010${String(index).padStart(2, "0")}`,
);

const NAMES: Record<string, string> = {
  [VEXX]: "vexx",
  [KAIRO]: "kairo",
  [KASPR]: "kaspr",
  [ZED]: "zed",
  [OKAMI]: "okami",
  [MARLOWE]: "marlowe",
  [BIG]: "Big",
  [BIG_BOB]: "Big Bob",
  ...Object.fromEntries(FILLER.map((steamId, index) => [steamId, `p${index}`])),
};

describe("ChatService mentions", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let hashes: Map<string, Map<string, string>>;
  let roles: Record<string, string>;
  let roster: string[];
  let lineup: string[];
  let lobby: string[];
  // [blocker, blocked]
  let blocks: Array<[string, string]>;

  const hash = (key: string) => {
    if (!hashes.has(key)) {
      hashes.set(key, new Map());
    }

    return hashes.get(key);
  };

  const redis = {
    hget: jest.fn(
      async (key: string, field: string) => hash(key).get(field) ?? null,
    ),
    hset: jest.fn(async (key: string, field: string, value: string) => {
      hash(key).set(field, value);
      return 1;
    }),
    hgetall: jest.fn(async (key: string) => Object.fromEntries(hash(key))),
    hdel: jest.fn(async (key: string, field: string) =>
      hash(key).delete(field) ? 1 : 0,
    ),
    get: jest.fn(async (): Promise<string | null> => null),
    set: jest.fn(async () => "OK"),
    expire: jest.fn(async () => 1),
    publish: jest.fn(async () => 1),
    sendCommand: jest.fn(async () => [1]),
    eval: jest.fn(async (script: string, _keys: number, ...args: string[]) => {
      if (script.includes("INCR")) {
        return 1;
      }

      if (script.includes("SADD")) {
        return [1, 1];
      }

      if (script.includes("HPEXPIRETIME") && script.includes("ARGV[3]")) {
        const [key, , field, expected, next] = args;

        if (hash(key).get(field) !== expected) {
          return 0;
        }

        hash(key).set(field, next);
        return 1;
      }

      return 1;
    }),
  };

  const postgres = {
    query: jest.fn(async (sql: string): Promise<any[]> => {
      if (sql.includes("public.is_gagged")) {
        return [{ gagged: false }];
      }

      if (sql.includes("AS chat_open")) {
        return [{ chat_open: true }];
      }

      if (sql.includes("public.can_view_direct_room")) {
        return [{ allowed: true }];
      }

      if (sql.includes("INSERT INTO public.chat_message_edits")) {
        return [{ id: "edit-audit-1" }];
      }

      return [];
    }),
    transaction: jest.fn(),
  };

  const roleOf = (steamId: string) => roles[steamId] ?? "user";

  const playerBlocks = {
    hasBlocked: jest.fn(async (blocker: string, blocked: string) =>
      blocks.some(([x, y]) => x === blocker && y === blocked),
    ),
    blockedBy: jest.fn(async (viewer: string, exempt: string[] = []) =>
      exempt.includes(roleOf(viewer))
        ? new Set<string>()
        : new Set(
            blocks
              .filter(([blocker]) => blocker === viewer)
              .map(([, blocked]) => blocked),
          ),
    ),
    blockedAmong: jest.fn(
      async (viewers: string[], authors: string[], exempt: string[] = []) => {
        const found = new Map<string, Set<string>>();

        for (const [blocker, blocked] of blocks) {
          if (
            viewers.includes(blocker) &&
            authors.includes(blocked) &&
            !exempt.includes(roleOf(blocker))
          ) {
            found.set(blocker, (found.get(blocker) ?? new Set()).add(blocked));
          }
        }

        return found;
      },
    ),
  };

  const push = {
    sendChatMessage: jest.fn(async () => {}),
    claimMentionPushes: jest.fn(
      async (_sender: string, steamIds: string[]) => steamIds,
    ),
    takingPushes: jest.fn(async (steamIds: string[]) => steamIds),
    editChatMessage: jest.fn(async () => {}),
    retractChatMessage: jest.fn(async () => {}),
  };

  const players = (steamIds: string[]) =>
    steamIds.map((steam_id) => ({
      steam_id,
      name: NAMES[steam_id],
      avatar_url: `avatars/${steam_id}.png`,
    }));

  const hasuraService = {
    getPlayerRole: jest.fn(async (steamId: string) => roleOf(String(steamId))),
    query: jest.fn(async (query: any, asUser?: string) => {
      if (query.tournaments) {
        return {
          tournaments: [...roster, MARLOWE].includes(String(asUser))
            ? [{ id: "t-1" }]
            : [],
        };
      }

      if (query.tournaments_by_pk) {
        return {
          tournaments_by_pk: {
            name: "Autumn Cup",
            organizer_steam_id: MARLOWE,
            organizers: [],
            teams: [
              {
                name: "Northwind",
                owner_steam_id: roster[0],
                roster: roster.map((player_steam_id) => ({ player_steam_id })),
              },
            ],
            free_agents: [],
          },
        };
      }

      if (query.matches_by_pk?.is_in_lineup) {
        return {
          matches_by_pk: {
            is_coach: false,
            is_organizer: false,
            is_in_lineup: lineup.includes(String(asUser)),
          },
        };
      }

      if (query.matches_by_pk) {
        return {
          matches_by_pk: {
            organizer_steam_id: null,
            lineup_1: {
              name: "Northwind",
              coach_steam_id: null,
              lineup_players: lineup.map((steam_id) => ({ steam_id })),
            },
            lineup_2: {
              name: "Iron Lotus",
              coach_steam_id: null,
              lineup_players: [],
            },
          },
        };
      }

      if (query.lobby_players_by_pk) {
        return {
          lobby_players_by_pk: lobby.includes(
            String(query.lobby_players_by_pk.__args.steam_id),
          )
            ? { status: "Accepted" }
            : null,
        };
      }

      if (query.lobby_players) {
        return { lobby_players: lobby.map((steam_id) => ({ steam_id })) };
      }

      if (query.players_by_pk) {
        const steamId = String(query.players_by_pk.__args.steam_id);

        return {
          players_by_pk: {
            steam_id: steamId,
            name: NAMES[steamId],
            role: roleOf(steamId),
          },
        };
      }

      if (query.players) {
        const where = query.players.__args.where;

        if (where.role) {
          return {
            players: Object.keys(NAMES)
              .filter((steamId) => where.role._in.includes(roleOf(steamId)))
              .map((steam_id) => ({ steam_id })),
          };
        }

        return {
          players: players(
            (where.steam_id._in as string[]).filter(
              (steamId) => NAMES[steamId],
            ),
          ),
        };
      }

      return {};
    }),
  };

  let service: ChatService;

  const as = (steamId: string) =>
    ({
      steam_id: steamId,
      name: NAMES[steamId],
      role: roleOf(steamId),
      avatar_url: null,
      profile_url: null,
    }) as any;

  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const seat = (type: ChatLobbyType, id: string, steamId: string) =>
    hash(`chat:${type}:${id}`).set(
      steamId,
      JSON.stringify({ user: { steam_id: steamId } }),
    );

  const say = async (
    text: string,
    mentions?: unknown,
    {
      type = ChatLobbyType.Tournament,
      id = "t-1",
      from = VEXX,
      source = "web" as "web" | "game",
    } = {},
  ) => {
    seat(type, id, from);

    const result = await service.sendMessageToChat(
      type,
      id,
      as(from),
      text,
      false,
      source,
      undefined,
      mentions,
    );

    await flush();

    return result;
  };

  const stored = (type = ChatLobbyType.Tournament, id = "t-1") =>
    [...hash(`chat_${type}_${id}`).values()].map((raw) => JSON.parse(raw));

  const pushes = () =>
    push.sendChatMessage.mock.calls.map(([steamIds, chatPush]: any[]) => ({
      steamIds: [...steamIds].sort(),
      push: chatPush,
    }));

  const published = (event: string) =>
    redis.publish.mock.calls
      .map(([, payload]: any[]) => JSON.parse(payload))
      .filter((sent) => sent.event === event);

  beforeEach(() => {
    jest.clearAllMocks();
    hashes = new Map();
    roles = { [OKAMI]: "moderator", [MARLOWE]: "tournament_organizer" };
    roster = [VEXX, KAIRO, KASPR, OKAMI, ...FILLER];
    lineup = [VEXX, KAIRO, KASPR];
    lobby = [VEXX, KAIRO];
    blocks = [];

    service = new ChatService(
      logger as any,
      { connect: jest.fn() } as any,
      hasuraService as any,
      postgres as any,
      { getConnection: () => redis } as any,
      push as any,
      playerBlocks as any,
      {
        claim: jest.fn(),
        markDeleted: jest.fn(async () => {}),
        expireMessage: jest.fn(async () => {}),
      } as any,
      { enabled: jest.fn(async () => false) } as any,
    );
  });

  describe("sending", () => {
    it("stores who was tagged, by steam id and the name the text uses", async () => {
      await expect(
        say("@kairo @kaspr check-in in 5", [KAIRO, KASPR]),
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });

      expect(stored()).toEqual([
        expect.objectContaining({
          message: "@kairo @kaspr check-in in 5",
          mentions: [
            { steam_id: KAIRO, name: "kairo" },
            { steam_id: KASPR, name: "kaspr" },
          ],
        }),
      ]);
    });

    it("sends the room the tags with the message", async () => {
      seat(ChatLobbyType.Tournament, "t-1", KAIRO);

      await say("@kairo ready?", [KAIRO]);

      expect(published("lobby:tournament:t-1:chat")).toContainEqual(
        expect.objectContaining({
          steamId: KAIRO,
          data: expect.objectContaining({
            mentions: [{ steam_id: KAIRO, name: "kairo" }],
          }),
        }),
      );
    });

    it("leaves out someone who cannot read the room", async () => {
      await say("@zed @kairo you there?", [ZED, KAIRO]);

      expect(stored()[0].mentions).toEqual([
        { steam_id: KAIRO, name: "kairo" },
      ]);
      expect(pushes().flatMap(({ steamIds }) => steamIds)).not.toContain(ZED);
    });

    it("leaves out a pick whose name is not in the text", async () => {
      await say("hello", [KAIRO]);

      expect(stored()[0]).not.toHaveProperty("mentions");
    });

    it("does not take a name that only starts a longer word", async () => {
      await say("@kairos is a different person", [KAIRO]);

      expect(stored()[0]).not.toHaveProperty("mentions");
    });

    it("does not tag a member whose name only starts a longer tagged name", async () => {
      roster = [VEXX, BIG, BIG_BOB];

      await say("@Big Bob gg", [BIG, BIG_BOB]);

      expect(stored()[0].mentions).toEqual([
        { steam_id: BIG_BOB, name: "Big Bob" },
      ]);
    });

    it("tags both when each name has an @ of its own", async () => {
      roster = [VEXX, BIG, BIG_BOB];

      await say("@Big Bob and @Big", [BIG, BIG_BOB]);

      expect(stored()[0].mentions).toEqual([
        { steam_id: BIG, name: "Big" },
        { steam_id: BIG_BOB, name: "Big Bob" },
      ]);
    });

    it("sends the line without tags when they cannot be looked up", async () => {
      const answer = hasuraService.query.getMockImplementation();
      hasuraService.query.mockImplementation(async (query, asUser) => {
        if (query.players?.__args?.where?.steam_id) {
          throw "connection reset";
        }
        return await answer(query, asUser);
      });

      try {
        await expect(say("@kairo hi", [KAIRO])).resolves.toEqual({
          accepted: true,
          messageId: expect.any(String),
        });
      } finally {
        hasuraService.query.mockImplementation(answer);
      }

      expect(stored()[0]).toMatchObject({ message: "@kairo hi" });
      expect(stored()[0]).not.toHaveProperty("mentions");
      expect(logger.warn).toHaveBeenCalled();
    });

    it("reads the room's roster once for a tagged line", async () => {
      await say("@kairo hi", [KAIRO]);

      expect(
        hasuraService.query.mock.calls.filter(
          ([query]: any[]) => query.tournaments_by_pk?.teams,
        ),
      ).toHaveLength(1);
    });

    it("never tags the sender", async () => {
      await say("@vexx talking to myself", [VEXX]);

      expect(stored()[0]).not.toHaveProperty("mentions");
    });

    it("refuses more than ten tags, rather than dropping the rest", async () => {
      const picks = FILLER.slice(0, 11);
      const text = picks.map((steamId) => `@${NAMES[steamId]}`).join(" ");

      await expect(say(text, picks)).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.TooManyMentions,
      });

      expect(stored()).toEqual([]);
      expect(hasuraService.query).not.toHaveBeenCalledWith(
        expect.objectContaining({ players: expect.anything() }),
      );
      expect(push.claimMentionPushes).not.toHaveBeenCalled();
      expect(push.sendChatMessage).not.toHaveBeenCalled();
    });

    it("takes exactly ten, counting a player picked twice once", async () => {
      const picks = FILLER.slice(0, 10);
      const text = picks.map((steamId) => `@${NAMES[steamId]}`).join(" ");

      await expect(say(text, [...picks, picks[0]])).resolves.toEqual({
        accepted: true,
        messageId: expect.any(String),
      });

      expect(stored()[0].mentions).toHaveLength(10);
    });

    it("counts the sender's own id toward the ten", async () => {
      const picks = FILLER.slice(0, 10);
      const text = picks.map((steamId) => `@${NAMES[steamId]}`).join(" ");

      await expect(say(`@vexx ${text}`, [VEXX, ...picks])).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.TooManyMentions,
      });
    });

    it.each([
      ["a string", KAIRO],
      ["a number in the list", [Number(KAIRO)]],
      ["an object in the list", [{ steam_id: KAIRO }]],
      ["something that is not a steam id", ["kairo"]],
    ])("refuses tags sent as %s", async (_, mentions) => {
      await expect(say("@kairo hi", mentions)).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.Invalid,
      });

      expect(stored()).toEqual([]);
    });

    it("refuses tags in a direct conversation", async () => {
      const room = directRoomId(VEXX, KAIRO);

      await expect(
        say("@kairo hi", [KAIRO], { type: ChatLobbyType.Direct, id: room }),
      ).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.NotAllowed,
      });

      expect(
        postgres.query.mock.calls.some(([sql]: [string]) =>
          sql.includes("INSERT INTO public.direct_messages"),
        ),
      ).toBe(false);
    });

    it("takes no tags from a line relayed from the game", async () => {
      await say("@kairo nice", [KAIRO], { source: "game" });

      expect(stored()[0]).not.toHaveProperty("mentions");
    });

    it.each([
      [ChatLobbyType.Match, "m-1", KAIRO],
      [ChatLobbyType.MatchMaking, "lobby-1", KAIRO],
      [ChatLobbyType.Organizer, "organizers", MARLOWE],
    ])("tags members of a %s room", async (type, id, member) => {
      roles[VEXX] = "match_organizer";

      await say(`@${NAMES[member]} look`, [member], { type, id });

      expect(stored(type, id)[0].mentions).toEqual([
        { steam_id: member, name: NAMES[member] },
      ]);
    });
  });

  describe("push", () => {
    it("pushes a tagged member a mention in place of the regular push", async () => {
      roster = [VEXX, KAIRO, KASPR];

      await say("@kairo up next on Nuke", [KAIRO]);

      expect(pushes()).toEqual([
        {
          steamIds: [KASPR, MARLOWE],
          push: expect.objectContaining({ title: "vexx" }),
        },
        {
          steamIds: [KAIRO],
          push: expect.objectContaining({
            title: "vexx",
            message: "@kairo up next on Nuke",
            mention: true,
            threadKey: "chat:tournament:t-1",
          }),
        },
      ]);
      expect(pushes()[0].push).not.toHaveProperty("mention");
    });

    it("never pushes a mention to someone who blocked the sender, whatever their role", async () => {
      roster = [VEXX, KAIRO, OKAMI];
      blocks = [[OKAMI, VEXX]];

      await say("@okami @kairo can you look", [OKAMI, KAIRO]);

      const mention = pushes().find(({ push }) => push.mention);

      expect(mention.steamIds).toEqual([KAIRO]);
      // A moderator's block leaves a group room alone, as before.
      expect(pushes().find(({ push }) => !push.mention).steamIds).toEqual([
        OKAMI,
        MARLOWE,
      ]);
    });

    it("pushes a player the sender just tagged the room's ordinary message", async () => {
      roster = [VEXX, KAIRO, KASPR];
      push.claimMentionPushes.mockResolvedValueOnce([]);

      await say("@kairo again", [KAIRO]);

      expect(push.claimMentionPushes).toHaveBeenCalledWith(
        VEXX,
        [KAIRO],
        "@kairo again",
      );
      expect(pushes()).toEqual([
        {
          steamIds: [KAIRO, KASPR, MARLOWE],
          push: expect.not.objectContaining({ mention: true }),
        },
      ]);
    });

    it("asks to push a tag only for players who did not block the sender", async () => {
      roster = [VEXX, KAIRO, OKAMI];
      blocks = [[OKAMI, VEXX]];

      await say("@okami @kairo look", [OKAMI, KAIRO]);

      expect(push.claimMentionPushes).toHaveBeenCalledWith(
        VEXX,
        [KAIRO],
        "@okami @kairo look",
      );
    });

    it("pushes nothing again for an edit", async () => {
      roster = [VEXX, KAIRO];
      const sent = await say("@kairo check-in", [KAIRO]);
      const before = push.sendChatMessage.mock.calls.length;

      await service.editMessage(
        ChatLobbyType.Tournament,
        "t-1",
        sent.accepted ? sent.messageId : "",
        as(VEXX),
        "@kairo check-in now",
      );
      await flush();

      expect(push.sendChatMessage).toHaveBeenCalledTimes(before);
      expect(push.claimMentionPushes).toHaveBeenCalledTimes(1);
    });

    it("pushes a tag in a match room under chat, which is on by default", async () => {
      roles[VEXX] = "match_organizer";

      await say("@kaspr swap", [KASPR], {
        type: ChatLobbyType.Match,
        id: "m-1",
      });

      expect(pushes()).toEqual([
        {
          steamIds: [KAIRO],
          push: expect.objectContaining({ type: "MatchChatMessage" }),
        },
        {
          steamIds: [KASPR],
          push: expect.objectContaining({ type: "ChatMessage", mention: true }),
        },
      ]);
    });

    it("keeps the line as an ordinary push for a player who turned chat pushes off", async () => {
      roles[VEXX] = "match_organizer";
      push.takingPushes.mockResolvedValueOnce([]);

      await say("@kaspr swap", [KASPR], {
        type: ChatLobbyType.Match,
        id: "m-1",
      });

      expect(push.takingPushes).toHaveBeenCalledWith([KASPR], "ChatMessage");
      expect(push.claimMentionPushes).not.toHaveBeenCalled();
      expect(pushes()).toEqual([
        {
          steamIds: [KAIRO, KASPR],
          push: expect.objectContaining({ type: "MatchChatMessage" }),
        },
      ]);
    });

    it("carries the room's own kind of push on a tag, for an edit to fall back to", async () => {
      roles[VEXX] = "match_organizer";

      await say("@kaspr swap", [KASPR], {
        type: ChatLobbyType.Match,
        id: "m-1",
      });

      expect(pushes().find(({ push }) => push.mention).push).toMatchObject({
        type: "ChatMessage",
        plainType: "MatchChatMessage",
      });
    });

    it("tells the push gate who an edit still tags", async () => {
      roster = [VEXX, KAIRO, KASPR];
      const sent = await say("@kairo @kaspr check-in", [KAIRO, KASPR]);

      await service.editMessage(
        ChatLobbyType.Tournament,
        "t-1",
        sent.accepted ? sent.messageId : "",
        as(VEXX),
        "@kaspr check-in",
      );

      expect(push.editChatMessage).toHaveBeenCalledWith(
        sent.accepted ? sent.messageId : "",
        "@kaspr check-in",
        [KASPR],
      );
    });

    it("pushes nothing to a player who blocked the sender", async () => {
      roster = [VEXX, KAIRO, KASPR];
      blocks = [[KAIRO, VEXX]];

      await say("@kairo hi", [KAIRO]);

      expect(pushes().flatMap(({ steamIds }) => steamIds)).toEqual([
        KASPR,
        MARLOWE,
      ]);
    });
  });

  describe("who is shown the tag", () => {
    it("does not tell the sender who blocked them", async () => {
      roster = [VEXX, KAIRO, OKAMI];
      blocks = [[OKAMI, VEXX]];

      await say("@okami hi", [OKAMI]);

      expect(stored()[0].mentions).toEqual([
        { steam_id: OKAMI, name: "okami" },
      ]);
      expect(published("lobby:tournament:t-1:chat")).toContainEqual(
        expect.objectContaining({
          steamId: VEXX,
          data: expect.objectContaining({
            mentions: [{ steam_id: OKAMI, name: "okami" }],
          }),
        }),
      );
    });

    it("hides a tag live from a moderator who blocked its author", async () => {
      roster = [VEXX, KAIRO, OKAMI];
      blocks = [[OKAMI, VEXX]];
      seat(ChatLobbyType.Tournament, "t-1", OKAMI);
      seat(ChatLobbyType.Tournament, "t-1", KAIRO);

      await say("@okami @kairo hi", [OKAMI, KAIRO]);

      const [toModerator] = published("lobby:tournament:t-1:chat").filter(
        (sent) => sent.steamId === OKAMI,
      );
      const [toKairo] = published("lobby:tournament:t-1:chat").filter(
        (sent) => sent.steamId === KAIRO,
      );

      expect(toModerator.data.message).toBe("@okami @kairo hi");
      expect(toModerator.data.mentions).toEqual([
        { steam_id: KAIRO, name: "kairo" },
      ]);
      expect(toKairo.data.mentions).toEqual([
        { steam_id: OKAMI, name: "okami" },
        { steam_id: KAIRO, name: "kairo" },
      ]);
    });

    it("hides it from that moderator's history too", async () => {
      roster = [VEXX, KAIRO, OKAMI];
      blocks = [[OKAMI, VEXX]];

      await say("@okami @kairo hi", [OKAMI, KAIRO]);

      const socket = {
        id: "client-okami",
        user: as(OKAMI),
        send: jest.fn(),
        on: jest.fn(),
      } as any;

      await service.joinMatchLobby(socket, ChatLobbyType.Tournament, "t-1");

      const history = socket.send.mock.calls
        .map(([raw]: [string]) => JSON.parse(raw))
        .find((sent: any) => sent.event === "lobby:tournament:t-1:messages");

      expect(history.data.messages).toEqual([
        expect.objectContaining({
          message: "@okami @kairo hi",
          mentions: [{ steam_id: KAIRO, name: "kairo" }],
        }),
      ]);
    });
  });

  describe("editing", () => {
    it("drops a tag whose name an edit took out", async () => {
      const sent = await say("@kairo @kaspr check-in", [KAIRO, KASPR]);

      await expect(
        service.editMessage(
          ChatLobbyType.Tournament,
          "t-1",
          sent.accepted ? sent.messageId : "",
          as(VEXX),
          "@kaspr check-in",
        ),
      ).resolves.toMatchObject({ edited: true });

      expect(stored()[0].mentions).toEqual([
        { steam_id: KASPR, name: "kaspr" },
      ]);
    });

    it("drops a shorter name an edit leaves only inside a longer one", async () => {
      roster = [VEXX, BIG, BIG_BOB];
      const sent = await say("@Big Bob and @Big", [BIG, BIG_BOB]);

      await service.editMessage(
        ChatLobbyType.Tournament,
        "t-1",
        sent.accepted ? sent.messageId : "",
        as(VEXX),
        "@Big Bob only",
      );

      expect(stored()[0].mentions).toEqual([
        { steam_id: BIG_BOB, name: "Big Bob" },
      ]);
    });

    it("keeps no empty list once every tag is gone", async () => {
      const sent = await say("@kairo check-in", [KAIRO]);

      await service.editMessage(
        ChatLobbyType.Tournament,
        "t-1",
        sent.accepted ? sent.messageId : "",
        as(VEXX),
        "check-in",
      );

      expect(stored()[0]).not.toHaveProperty("mentions");
    });
  });

  describe("who can be tagged", () => {
    it("lists the room's members with their team, leaving out the asker", async () => {
      roster = [VEXX, KAIRO, KASPR];

      await expect(
        service.mentionCandidates(ChatLobbyType.Tournament, "t-1", as(VEXX)),
      ).resolves.toEqual([
        {
          steam_id: KAIRO,
          name: "kairo",
          avatar_url: `avatars/${KAIRO}.png`,
          team: "Northwind",
          organizer: false,
        },
        {
          steam_id: KASPR,
          name: "kaspr",
          avatar_url: `avatars/${KASPR}.png`,
          team: "Northwind",
          organizer: false,
        },
        {
          steam_id: MARLOWE,
          name: "marlowe",
          avatar_url: `avatars/${MARLOWE}.png`,
          team: null,
          organizer: true,
        },
      ]);
    });

    it("lists nobody to someone outside the room", async () => {
      await expect(
        service.mentionCandidates(ChatLobbyType.Tournament, "t-1", as(ZED)),
      ).resolves.toBeNull();
    });

    it("lists nobody in a team room, which nothing opens yet, and logs nothing", async () => {
      await expect(
        service.mentionCandidates(
          ChatLobbyType.Team,
          "6f1c1c1e-5b1a-4c55-9a51-111111111111",
          as(VEXX),
        ),
      ).resolves.toBeNull();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each([
      [ChatLobbyType.Tournament, "t-1", false],
      [ChatLobbyType.Tournament, "6f1c1c1e-5b1a-4c55-9a51-111111111111", true],
      [ChatLobbyType.Match, "x", false],
      [
        ChatLobbyType.MatchTeam,
        "6f1c1c1e-5b1a-4c55-9a51-111111111111:6f1c1c1e-5b1a-4c55-9a51-222222222222",
        true,
      ],
      [ChatLobbyType.MatchTeam, "6f1c1c1e-5b1a-4c55-9a51-111111111111", false],
      [ChatLobbyType.Organizer, "organizers", true],
      [ChatLobbyType.Organizer, "anything", false],
    ])("knows a %s room id %s is well formed: %s", (type, id, valid) => {
      expect(ChatService.isRoomId(type, id)).toBe(valid);
    });

    it("lists nobody in a direct conversation", async () => {
      await expect(
        service.mentionCandidates(
          ChatLobbyType.Direct,
          directRoomId(VEXX, KAIRO),
          as(VEXX),
        ),
      ).resolves.toBeNull();
    });
  });

  describe("finding tags in the text", () => {
    const tagged = (text: string, names: string[]) => [
      ...ChatService.mentionedNames(text, names),
    ];

    it.each([
      ["@kairo hi", true],
      ["hi @kairo", true],
      ["hi @kairo, you up?", true],
      ["(@kairo)", true],
      ["@kairo's turn", true],
      ["@kairos", false],
      ["@kairo_2", false],
      ["mail@kairo", false],
      ["kairo", false],
      ["@Kairo", false],
    ])("%s", (text, found) => {
      expect(tagged(text, ["kairo"])).toEqual(found ? ["kairo"] : []);
    });

    it("finds a name with spaces in it", () => {
      expect(tagged("gg @Big Bob", ["Big Bob"])).toEqual(["Big Bob"]);
    });

    it("gives an @ to the longest name that starts there", () => {
      expect(tagged("gg @Big Bob", ["Big", "Big Bob"])).toEqual(["Big Bob"]);
      expect(tagged("@Big Bob and @Big", ["Big Bob", "Big"]).sort()).toEqual([
        "Big",
        "Big Bob",
      ]);
      expect(tagged("@kairo @kai", ["kai", "kairo"]).sort()).toEqual([
        "kai",
        "kairo",
      ]);
    });

    it("never finds an empty name", () => {
      expect(tagged("@ hi", [""])).toEqual([]);
    });
  });
});
