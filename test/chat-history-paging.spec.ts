import { randomUUID } from "crypto";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { ChatGateway } from "./../src/chat/chat.gateway";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { directRoomId } from "./../src/chat/utilities/directRoomId";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));

// Paging back through a room: the ordered index each redis room keeps beside
// its hash, kept in step by every write and rebuilt from the hash when it is
// missing, and the "load older" request, which answers to the same access
// check and the same per-reader filtering as a join. Against real redis, since
// the index is Lua over hash-field expiry, and real postgres for the roster,
// the blocks and the direct messages.
describe("chat history paging (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;
  let gateway: ChatGateway;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const attachments = {
    claim: jest.fn(),
    expireMessage: jest.fn(async () => {}),
    markDeleted: jest.fn(async () => {}),
    moveRoom: jest.fn(async () => {}),
  };

  const hasura = {
    query: jest.fn(async (query: any) => {
      if (query.players_by_pk) {
        const [player] = await postgres.query<Array<Record<string, string>>>(
          `SELECT steam_id::text AS steam_id, name, role::text AS role
             FROM players WHERE steam_id = $1::bigint`,
          [String(query.players_by_pk.__args.steam_id)],
        );
        return { players_by_pk: player ?? null };
      }

      if (query.players) {
        const players = await postgres.query<Array<Record<string, string>>>(
          `SELECT steam_id::text AS steam_id, name
             FROM players WHERE steam_id = ANY($1::bigint[])`,
          [query.players.__args.where.steam_id._in.map(String)],
        );
        return { players };
      }

      if (query.matches_by_pk) {
        return {
          matches_by_pk: {
            is_coach: false,
            is_organizer: true,
            is_in_lineup: false,
          },
        };
      }

      if (query.draft_games) {
        return { draft_games: [{ id: query.draft_games.__args.where.id._eq }] };
      }

      return {};
    }),
  };

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    db = await bootMigratedDb("ChatHistoryPagingTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196500000000n);

    chat = new ChatService(
      logger as any,
      {} as any,
      hasura as any,
      postgres,
      { getConnection: () => redis } as any,
      {
        sendChatMessage: jest.fn(async () => {}),
        retractChatMessage: jest.fn(async () => {}),
        editChatMessage: jest.fn(async () => {}),
      } as any,
      new PlayerBlocksService(postgres),
      attachments as any,
      { enabled: jest.fn(async () => false) } as any,
    );
    gateway = new ChatGateway(chat);
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  type Team = {
    id: string;
    owner: string;
    starter: string;
    stranger: string;
    moderator: string;
  };

  let team: Team;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    chat.updateChatMessageTTL(ChatLobbyType.Team, 30 * 24 * 60 * 60);
    await redis.flushall();
    await postgres.query("DELETE FROM direct_messages");
    await postgres.query("DELETE FROM direct_conversations");
    await postgres.query("DELETE FROM friends");
    await postgres.query("DELETE FROM player_blocks");
    await postgres.query("DELETE FROM team_invites");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");

    const { id, owner } = await fx.team();
    team = {
      id,
      owner,
      starter: await fx.player("Starter"),
      stranger: await fx.player("Stranger"),
      moderator: await fx.player("Moderator", "moderator"),
    };

    await runAsUser(postgres, team.owner, "admin", (query) =>
      query(
        `INSERT INTO team_roster (team_id, player_steam_id, status)
         VALUES ($1, $2, 'Starter')`,
        [team.id, team.starter],
      ),
    );
  });

  const user = async (steamId: string) => {
    const [row] = await postgres.query<
      Array<{ steam_id: string; name: string; role: string }>
    >(
      `SELECT steam_id::text AS steam_id, name, role::text AS role
         FROM players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return row as any;
  };

  const client = (steamId: string) => ({
    id: `client-${steamId}-${randomUUID()}`,
    user: { steam_id: steamId },
    authentication: Promise.resolve(),
    send: jest.fn(),
    on: jest.fn(),
  });

  type Page = {
    id: string;
    messages: Array<{ id: string; message: string; mentions?: unknown[] }>;
    more: boolean;
    cursor: string | null;
    requestId?: string;
  };

  const sent = (socket: ReturnType<typeof client>, event: string) =>
    socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((frame) => frame.event === event)
      .map(({ data }) => data);

  const join = async (
    steamId: string,
    type = ChatLobbyType.Team,
    id = team.id,
  ): Promise<Page | undefined> => {
    const socket = client(steamId);
    await chat.joinMatchLobby(socket as any, type, id);
    return sent(socket, `lobby:${type}:${id}:messages`)[0];
  };

  const older = async (
    steamId: string,
    before: unknown,
    type = ChatLobbyType.Team,
    id = team.id,
  ) => {
    const socket = client(steamId);
    await gateway.history(
      { type, id, before: before as string, requestId: "request-1" },
      socket as any,
    );
    return {
      page: sent(socket, `lobby:${type}:${id}:history`)[0] as Page | undefined,
      error: sent(socket, "chat:error")[0],
    };
  };

  // Rate limited per sender, so each line clears the sender's window first.
  // Who may post is team-chat.spec's subject, not this one's.
  const say = async (
    steamId: string,
    text: string,
    type = ChatLobbyType.Team,
    id = team.id,
    mentions?: string[],
  ) => {
    await redis.del(`chat:message-rate:${steamId}`);
    const result = await chat.sendMessageToChat(
      type,
      id,
      await user(steamId),
      text,
      true,
      "web",
      undefined,
      mentions,
    );
    expect(result).toEqual(expect.objectContaining({ accepted: true }));
    return (result as { messageId: string }).messageId;
  };

  const roomKey = (type = ChatLobbyType.Team, id = team.id) =>
    `chat_${type}_${id}`;

  const indexKey = (type = ChatLobbyType.Team, id = team.id) =>
    `chat_index_${type}_${id}`;

  const indexed = async (type = ChatLobbyType.Team, id = team.id) =>
    (await redis.zrange(indexKey(type, id), 0, -1)).map(
      (member) => member.split("|")[1],
    );

  // Written straight into the room's hash, as a message stored before rooms
  // had an index sits there: no index entry.
  const seed = async (
    count: number,
    {
      type = ChatLobbyType.Team,
      id = team.id,
      from = team.owner,
      startAt = Date.now() - 60 * 60 * 1000,
      mentions = undefined as unknown[] | undefined,
    } = {},
  ) => {
    const ids: string[] = [];
    const fields: string[] = [];

    for (let index = 0; index < count; index++) {
      const messageId = randomUUID();
      ids.push(messageId);
      fields.push(
        messageId,
        JSON.stringify({
          id: messageId,
          message: `line ${index}`,
          timestamp: new Date(startAt + index * 1000).toISOString(),
          source: "web",
          from: { role: "user", name: "Owner", steam_id: from },
          ...(mentions ? { mentions } : {}),
        }),
      );
    }

    if (fields.length > 0) {
      await redis.hset(roomKey(type, id), ...fields);
      await redis.call(
        "HEXPIRE",
        roomKey(type, id),
        3600,
        "FIELDS",
        count,
        ...ids,
      );
    }

    return ids;
  };

  const ids = (page?: Page) => page?.messages.map(({ id }) => id);

  describe("the index", () => {
    it("is built from the room on its first read, then takes each new message", async () => {
      const first = await say(team.starter, "before anyone read the room");
      expect(await redis.exists(indexKey())).toBe(0);

      expect(ids(await join(team.starter))).toEqual([first]);
      expect(await indexed()).toEqual([first]);

      const second = await say(team.owner, "after");
      expect(await indexed()).toEqual([first, second]);
    });

    it("builds itself whole from a room stored before indexes, in sent order", async () => {
      const seeded = await seed(5);
      const late = await say(team.starter, "sent before the first read");

      expect(await redis.exists(indexKey())).toBe(0);

      const page = await join(team.starter);
      expect(ids(page)).toEqual([...seeded, late]);
      expect(page?.more).toBe(false);
      expect(await indexed()).toEqual([...seeded, late]);
    });

    it("takes in a message stored around it, as a pod from before indexes does mid-deploy", async () => {
      const [first] = await seed(1);
      await join(team.starter);
      expect(await indexed()).toEqual([first]);

      const [unindexed] = await seed(1, { startAt: Date.now() });

      expect(ids(await join(team.starter))).toEqual([first, unindexed]);
      expect(await indexed()).toEqual([first, unindexed]);
    });

    it("drops a deleted message", async () => {
      const kept = await say(team.starter, "kept");
      await join(team.starter);
      const gone = await say(team.starter, "gone");
      expect(await indexed()).toEqual([kept, gone]);

      await expect(
        chat.deleteMessage(
          ChatLobbyType.Team,
          team.id,
          gone,
          await user(team.starter),
        ),
      ).resolves.toEqual({ deleted: true });

      expect(await indexed()).toEqual([kept]);
    });

    it("takes back a message whose send is rolled back", async () => {
      const kept = await say(team.starter, "kept");
      await join(team.starter);

      const attachmentId = randomUUID();
      attachments.claim.mockResolvedValueOnce([
        { id: attachmentId, mime_type: "image/png" },
      ]);
      jest
        .spyOn(postgres, "transaction")
        .mockImplementationOnce(async (fn: any) => {
          await fn({ query: jest.fn() });
          throw new Error("commit lost");
        });

      await redis.del(`chat:message-rate:${team.starter}`);
      await expect(
        chat.sendMessageToChat(
          ChatLobbyType.Team,
          team.id,
          await user(team.starter),
          "with a file",
          false,
          "web",
          { attachments: [attachmentId] },
        ),
      ).rejects.toThrow("commit lost");

      expect(await redis.hlen(roomKey())).toBe(1);
      expect(await indexed()).toEqual([kept]);
    });

    it("prunes a message that expired once a later one is stored", async () => {
      const [lasting] = await seed(1);
      chat.updateChatMessageTTL(ChatLobbyType.Team, 1);
      const expired = await say(team.starter, "short lived");
      await join(team.starter);
      expect(await indexed()).toEqual([lasting, expired]);

      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(await redis.hexists(roomKey(), expired)).toBe(0);

      const kept = await say(team.starter, "kept");

      expect(await indexed()).toEqual([lasting, kept]);
    });

    it("lives as long as the room's longest-lived message", async () => {
      await seed(1);
      chat.updateChatMessageTTL(ChatLobbyType.Team, 1);
      await say(team.starter, "short lived");
      await join(team.starter);

      const built = await redis.pttl(indexKey());
      expect(built).toBeGreaterThan(3_590_000);
      expect(built).toBeLessThanOrEqual(3_600_000);

      chat.updateChatMessageTTL(ChatLobbyType.Team, 7200);
      await say(team.starter, "longer lived");

      expect(await redis.pttl(indexKey())).toBeGreaterThan(7_190_000);
    });

    it("goes with the room once its last message expires", async () => {
      chat.updateChatMessageTTL(ChatLobbyType.Team, 1);
      await say(team.starter, "short lived");
      await join(team.starter);
      expect(await redis.exists(indexKey())).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 2100));

      expect(await redis.exists(indexKey())).toBe(0);
      expect(await redis.exists(roomKey())).toBe(0);
    });

    it("skips and drops a member whose message is gone when a read reaches it", async () => {
      const [first, second] = await seed(2);
      await join(team.starter);
      await redis.hdel(roomKey(), first);

      expect(ids(await join(team.starter))).toEqual([second]);
      expect(await indexed()).toEqual([second]);
    });

    it("moves with the room: into the new room's index, and the old one goes", async () => {
      const draftId = randomUUID();
      const matchId = randomUUID();

      const [early] = await seed(1, {
        type: ChatLobbyType.Match,
        id: matchId,
        startAt: Date.now() - 3 * 60 * 1000,
      });
      await join(team.starter, ChatLobbyType.Match, matchId);
      const drafted = await say(
        team.starter,
        "glhf",
        ChatLobbyType.Draft,
        draftId,
      );
      await join(team.starter, ChatLobbyType.Draft, draftId);
      expect(await indexed(ChatLobbyType.Draft, draftId)).toEqual([drafted]);

      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        draftId,
        ChatLobbyType.Match,
        matchId,
      );

      expect(await redis.exists(indexKey(ChatLobbyType.Draft, draftId))).toBe(
        0,
      );
      expect(await indexed(ChatLobbyType.Match, matchId)).toEqual([
        early,
        drafted,
      ]);
      expect(
        ids(await join(team.starter, ChatLobbyType.Match, matchId)),
      ).toEqual([early, drafted]);
    });

    it("leaves a room moved into with no index to be built on its next read", async () => {
      const draftId = randomUUID();
      const matchId = randomUUID();

      const [early] = await seed(1, {
        type: ChatLobbyType.Match,
        id: matchId,
        startAt: Date.now() - 3 * 60 * 1000,
      });
      const drafted = await say(
        team.starter,
        "glhf",
        ChatLobbyType.Draft,
        draftId,
      );

      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        draftId,
        ChatLobbyType.Match,
        matchId,
      );

      expect(
        ids(await join(team.starter, ChatLobbyType.Match, matchId)),
      ).toEqual([early, drafted]);
    });
  });

  describe("pages", () => {
    it("hands a join the newest 200, then pages back 50 at a time without gaps or repeats", async () => {
      const seeded = await seed(260);

      const newest = await join(team.starter);
      expect(ids(newest)).toEqual(seeded.slice(60));
      expect(newest?.more).toBe(true);

      const second = (await older(team.starter, newest?.cursor)).page;
      expect(ids(second)).toEqual(seeded.slice(10, 60));
      expect(second).toEqual(
        expect.objectContaining({
          id: team.id,
          more: true,
          requestId: "request-1",
        }),
      );

      const third = (await older(team.starter, second?.cursor)).page;
      expect(ids(third)).toEqual(seeded.slice(0, 10));
      expect(third?.more).toBe(false);
    });

    it("says nothing is older when a page ends on the room's first message", async () => {
      const seeded = await seed(250);

      const newest = await join(team.starter);
      expect(newest?.more).toBe(true);

      const last = (await older(team.starter, newest?.cursor)).page;
      expect(ids(last)).toEqual(seeded.slice(0, 50));
      expect(last?.more).toBe(false);
    });

    it("says nothing is older on joining a room shorter than a page", async () => {
      await seed(3);

      expect(await join(team.starter)).toEqual(
        expect.objectContaining({ more: false, cursor: expect.any(String) }),
      );
    });

    it("hands an empty room no cursor", async () => {
      expect(await join(team.starter)).toEqual({
        id: team.id,
        messages: [],
        more: false,
        cursor: null,
      });
    });

    it("keeps paging past a page whose every line the reader blocked", async () => {
      const own = await seed(5, { from: team.starter });
      await seed(250, {
        startAt: Date.now() - 30 * 60 * 1000,
      });
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1, $2)`,
        [team.starter, team.owner],
      );

      const newest = await join(team.starter);
      expect(newest?.messages).toEqual([]);
      expect(newest?.more).toBe(true);

      const blocked = (await older(team.starter, newest?.cursor)).page;
      expect(blocked?.messages).toEqual([]);
      expect(blocked?.more).toBe(true);

      const reached = (await older(team.starter, blocked?.cursor)).page;
      expect(ids(reached)).toEqual(own);
      expect(reached?.more).toBe(false);
    });
  });

  describe("who may page back", () => {
    it("answers only those a join admits: no stranger, and no staff off a team's roster", async () => {
      await seed(210);
      const cursor = (await join(team.owner))?.cursor;

      for (const steamId of [team.owner, team.starter]) {
        expect((await older(steamId, cursor)).page?.messages).toHaveLength(10);
      }

      for (const steamId of [team.stranger, team.moderator]) {
        const { page, error } = await older(steamId, cursor);
        expect(page).toBeUndefined();
        expect(error).toEqual({
          code: ChatErrorCode.NotAllowed,
          action: "history",
          requestId: "request-1",
        });
      }
    });

    it("refuses a cursor it never handed out", async () => {
      for (const before of [
        undefined,
        "",
        "1|2",
        "+",
        "-",
        `(${new Date().toISOString()}|x`,
      ]) {
        expect((await older(team.starter, before)).error).toEqual(
          expect.objectContaining({ code: ChatErrorCode.Invalid }),
        );
      }
    });

    it("takes a blocked player's tag off an older line a moderator still sees", async () => {
      const matchId = randomUUID();
      const author = await fx.player("Author");
      const [tagged] = await seed(1, {
        type: ChatLobbyType.Match,
        id: matchId,
        from: author,
        startAt: Date.now() - 2 * 60 * 60 * 1000,
        mentions: [{ steam_id: team.moderator, name: "Moderator" }],
      });
      await seed(200, { type: ChatLobbyType.Match, id: matchId });
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1, $2)`,
        [team.moderator, author],
      );

      const newest = await join(team.moderator, ChatLobbyType.Match, matchId);
      expect(newest?.more).toBe(true);

      const { page } = await older(
        team.moderator,
        newest?.cursor,
        ChatLobbyType.Match,
        matchId,
      );
      expect(page?.messages).toEqual([expect.objectContaining({ id: tagged })]);
      expect(page?.messages[0].mentions).toBeUndefined();
    });
  });

  describe("direct conversations", () => {
    const befriend = (room: string) =>
      postgres.query(
        `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
              VALUES (split_part($1, ':', 1)::bigint,
                      split_part($1, ':', 2)::bigint, 'Accepted')`,
        [room],
      );

    it("pages back by created_at and seq, splitting messages that share a timestamp", async () => {
      const me = await fx.player("Me");
      const friend = await fx.player("Friend");
      const room = directRoomId(me, friend);
      await befriend(room);

      const rows = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO direct_messages (room_id, from_steam_id, message, created_at)
         SELECT $1, $2, 'line ' || n,
                timestamptz '2026-10-01 12:00:00.123456+00'
                  + make_interval(secs => CASE WHEN n <= 2 THEN 0 ELSE n END)
           FROM generate_series(1, 205) AS n
          ORDER BY n
         RETURNING id::text AS id`,
        [room, friend],
      );
      const written = rows.map(({ id }) => id);

      const newest = await join(me, ChatLobbyType.Direct, room);
      expect(ids(newest)).toEqual(written.slice(5));
      expect(newest?.more).toBe(true);
      expect(newest?.cursor).toMatch(/^2026-10-01T12:00:06\.123456Z\|\d+$/);

      const rest = await older(me, newest?.cursor, ChatLobbyType.Direct, room);
      expect(rest.error).toBeUndefined();
      expect(ids(rest.page)).toEqual(written.slice(0, 5));
      expect(rest.page?.more).toBe(false);

      const [second] = await postgres.query<Array<{ seq: string }>>(
        "SELECT seq::text AS seq FROM direct_messages WHERE id = $1",
        [written[1]],
      );
      const sameInstant = await older(
        me,
        `2026-10-01T12:00:00.123456Z|${second.seq}`,
        ChatLobbyType.Direct,
        room,
      );
      expect(ids(sameInstant.page)).toEqual([written[0]]);
      expect(sameInstant.page?.cursor).toMatch(
        /^2026-10-01T12:00:00\.123456Z\|\d+$/,
      );
    });

    it("refuses a conversation's page to anyone outside it", async () => {
      const me = await fx.player("Me");
      const friend = await fx.player("Friend");
      const room = directRoomId(me, friend);

      const { error } = await older(
        team.stranger,
        "2026-10-01T12:00:00.123456Z|1",
        ChatLobbyType.Direct,
        room,
      );
      expect(error).toEqual(
        expect.objectContaining({ code: ChatErrorCode.NotAllowed }),
      );
    });
  });
});
