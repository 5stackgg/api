import { randomUUID } from "crypto";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { NotificationsService } from "./../src/notifications/notifications.service";
import { NotificationPreferencesService } from "./../src/notifications/preferences/notification-preferences.service";

// The edit is one compare-and-set script against real hash-field expiry, which
// no fake reproduces: HSET dropping a field's TTL is the whole reason it exists.
describe("chat edits and self deletes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;
  let notifications: NotificationsService;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const hasura = () => ({
    query: jest.fn(async (query: any) => {
      if (query.players_by_pk) {
        const [player] = await postgres.query<
          Array<{ steam_id: string; name: string; role: string }>
        >(
          `SELECT steam_id::text AS steam_id, name, role::text AS role
             FROM players WHERE steam_id = $1::bigint`,
          [query.players_by_pk.__args.steam_id],
        );
        return { players_by_pk: player ?? null };
      }

      // Who gets into which room is chat.service.spec's subject.
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
  });

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    db = await bootMigratedDb("ChatRedisActionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199610000000n);

    notifications = new NotificationsService(
      hasura() as any,
      postgres,
      logger as any,
      { get: () => ({ webDomain: "https://example.com" }) } as any,
      new NotificationPreferencesService(postgres),
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
    );

    chat = new ChatService(
      logger as any,
      {} as any,
      hasura() as any,
      postgres,
      { getConnection: () => redis } as any,
      notifications,
    );
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await redis.flushall();
    await postgres.query("DELETE FROM chat_message_deletions");
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM players");
  });

  const author = async () => {
    const steamId = await fx.player("Author");
    return { steam_id: steamId, name: "Author", role: "user" } as any;
  };

  const key = (matchId: string) => `chat_match_${matchId}`;

  const written = (id: string, from: any) =>
    JSON.stringify({
      id,
      message: "typo",
      timestamp: new Date().toISOString(),
      source: "web",
      from: {
        role: "user",
        name: "Author",
        steam_id: from.steam_id,
        avatar_url: null,
        profile_url: "https://steamcommunity.com/profiles/1/",
      },
    });

  const place = async (matchId: string, from: any) => {
    const id = randomUUID();
    await redis.hset(key(matchId), id, written(id, from));
    return id;
  };

  const expiresAt = async (matchId: string, id: string) =>
    (
      (await redis.call(
        "HPEXPIRETIME",
        key(matchId),
        "FIELDS",
        1,
        id,
      )) as number[]
    )[0];

  const edit = (matchId: string, id: string, user: any, text = "fixed") =>
    chat.editMessage(ChatLobbyType.Match, matchId, id, user, text);

  // Holds the edit between its read and its write, which is exactly where a
  // delete or an expiry has to be shown not to come back.
  const pauseFirstRead = (during: () => Promise<unknown>) => {
    const read = redis.hget.bind(redis);

    jest.spyOn(redis, "hget").mockImplementationOnce((async (
      hashKey: string,
      field: string,
    ) => {
      const value = await read(hashKey, field);
      await during();
      return value;
    }) as any);
  };

  describe("expiry", () => {
    it("keeps the expiry a sent message was given", async () => {
      const user = await author();
      const matchId = randomUUID();

      const sent = await chat.sendMessageToChat(
        ChatLobbyType.Match,
        matchId,
        user,
        "typo",
        true,
      );
      const id = sent.accepted ? sent.messageId : "";
      const before = await expiresAt(matchId, id);

      await new Promise((resolve) => setTimeout(resolve, 20));

      await expect(edit(matchId, id, user)).resolves.toMatchObject({
        edited: true,
      });

      expect(before).toBeGreaterThan(Date.now());
      expect(await expiresAt(matchId, id)).toBe(before);
    });

    it("keeps an expiry to the millisecond", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);
      const at = Date.now() + 123_457;
      await redis.call("HPEXPIREAT", key(matchId), at, "FIELDS", 1, id);

      await edit(matchId, id, user);

      expect(await expiresAt(matchId, id)).toBe(at);
    });

    it("gives a message with no expiry none", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);

      await edit(matchId, id, user);

      expect(await expiresAt(matchId, id)).toBe(-1);
      expect(JSON.parse(await redis.hget(key(matchId), id)).message).toBe(
        "fixed",
      );
    });

    it("never brings back a message that expired between the read and the write", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);
      await redis.call("HPEXPIRE", key(matchId), 150, "FIELDS", 1, id);

      pauseFirstRead(() => new Promise((resolve) => setTimeout(resolve, 300)));

      await expect(edit(matchId, id, user)).resolves.toEqual({
        edited: false,
        code: ChatErrorCode.NotFound,
      });

      expect(await redis.hexists(key(matchId), id)).toBe(0);
      expect(await expiresAt(matchId, id)).toBe(-2);
    });

    it("never brings back a message deleted between the read and the write", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);

      pauseFirstRead(() => redis.hdel(key(matchId), id));

      await expect(edit(matchId, id, user)).resolves.toEqual({
        edited: false,
        code: ChatErrorCode.NotFound,
      });

      expect(await redis.hexists(key(matchId), id)).toBe(0);
    });

    it("writes nothing for a value that has moved on", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);
      const current = await redis.hget(key(matchId), id);
      const at = Date.now() + 60_000;
      await redis.call("HPEXPIREAT", key(matchId), at, "FIELDS", 1, id);

      const script = (ChatService as any).EDIT_ROOM_MESSAGE_SCRIPT;

      await expect(
        redis.eval(script, 1, key(matchId), id, "stale", "replacement"),
      ).resolves.toBe(0);
      await expect(
        redis.eval(script, 1, key(matchId), randomUUID(), "", "replacement"),
      ).resolves.toBe(0);

      expect(await redis.hget(key(matchId), id)).toBe(current);
      expect(await expiresAt(matchId, id)).toBe(at);
      expect(await redis.hlen(key(matchId))).toBe(1);
    });
  });

  it("never resurrects a message when an edit races its deletion", async () => {
    const user = await author();

    for (let round = 0; round < 25; round++) {
      const matchId = randomUUID();
      const id = await place(matchId, user);

      const [edited, deleted] = await Promise.all([
        edit(matchId, id, user),
        chat.deleteMessage(ChatLobbyType.Match, matchId, id, user),
      ]);

      expect(deleted).toEqual({ deleted: true });
      expect([true, false]).toContain(edited.edited);
      expect(await redis.hexists(key(matchId), id)).toBe(0);
    }

    const [{ count }] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM chat_message_deletions
        WHERE deleted_by_steam_id = $1::bigint`,
      [user.steam_id],
    );

    expect(count).toBe("25");
  });

  it("stores the edit exactly as JSON.stringify writes it", async () => {
    const user = await author();
    const matchId = randomUUID();
    const id = await place(matchId, user);
    const original = JSON.parse(await redis.hget(key(matchId), id));
    const text = `héllo — 你好 🎉 a/b </script> "quoted" \\ back\nline`;

    const result = await edit(matchId, id, user, text);
    const raw = await redis.hget(key(matchId), id);

    expect(result.edited).toBe(true);
    expect(raw).toBe(
      JSON.stringify({
        ...original,
        message: text,
        edited_at: result.edited ? result.edited_at : undefined,
      }),
    );
    expect(raw).not.toContain("\\/");
    expect(JSON.parse(raw).from.avatar_url).toBeNull();
    expect(JSON.parse(raw).message).toBe(text);
  });

  it("carries the edit through history and a draft moving into its match", async () => {
    const user = await author();
    const draftId = randomUUID();
    const matchId = randomUUID();
    const id = randomUUID();
    await redis.hset(`chat_draft_${draftId}`, id, written(id, user));

    const result = await chat.editMessage(
      ChatLobbyType.Draft,
      draftId,
      id,
      user,
      "fixed",
    );

    await chat.migrateLobbyMessages(
      ChatLobbyType.Draft,
      draftId,
      ChatLobbyType.Match,
      matchId,
    );

    expect(await chat["getMessages"](ChatLobbyType.Match, matchId)).toEqual([
      expect.objectContaining({
        id,
        message: "fixed",
        edited_at: result.edited ? result.edited_at : undefined,
      }),
    ]);
  });

  it("audits an author deleting their own message", async () => {
    const user = await author();
    const matchId = randomUUID();
    const id = await place(matchId, user);

    await expect(
      chat.deleteMessage(ChatLobbyType.Match, matchId, id, user),
    ).resolves.toEqual({ deleted: true });

    const rows = await postgres.query<
      Array<{ author: string; deleted_by: string; message: string }>
    >(
      `SELECT author_steam_id::text AS author,
              deleted_by_steam_id::text AS deleted_by, message
         FROM chat_message_deletions WHERE message_id = $1::uuid`,
      [id],
    );

    expect(rows).toEqual([
      { author: user.steam_id, deleted_by: user.steam_id, message: "typo" },
    ]);
  });

  describe("the bell's preview", () => {
    const row = async (
      steamId: string,
      messageId: string,
      overrides: {
        is_read?: boolean;
        deleted?: boolean;
        message?: string;
      } = {},
    ) => {
      const [inserted] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO notifications
                (type, title, message, role, steam_id, entity_id, data,
                 is_read, deleted_at)
              VALUES ('MatchChatMessage', 'Author', $3, 'user', $1::bigint,
                      'match:m-1',
                      jsonb_build_object('messageId', $2::text),
                      $4, CASE WHEN $5 THEN now() END)
           RETURNING id::text AS id`,
        [
          steamId,
          messageId,
          overrides.message ?? "typo",
          overrides.is_read ?? false,
          overrides.deleted ?? false,
        ],
      );
      return inserted.id;
    };

    const text = async (id: string) =>
      (
        await postgres.query<Array<{ message: string }>>(
          `SELECT message FROM notifications WHERE id = $1::uuid`,
          [id],
        )
      )[0].message;

    it("shows the edited text on the recipient's unread row", async () => {
      const user = await author();
      const reader = await fx.player("Reader");
      const matchId = randomUUID();
      const id = await place(matchId, user);
      const unread = await row(reader, id);

      await edit(matchId, id, user, "<b>fixed</b>");

      expect(await text(unread)).toBe("&lt;b&gt;fixed&lt;/b&gt;");
    });

    it("rewrites only unread, live rows for that message", async () => {
      const reader = await fx.player("Reader");
      const messageId = randomUUID();
      const unread = await row(reader, messageId);
      const read = await row(reader, messageId, { is_read: true });
      const collapsed = await row(reader, messageId, { deleted: true });
      const other = await row(reader, randomUUID());

      await notifications.updateChatMessagePreview(messageId, "fixed");

      expect(await text(unread)).toBe("fixed");
      expect(await text(read)).toBe("typo");
      expect(await text(collapsed)).toBe("typo");
      expect(await text(other)).toBe("typo");
    });

    it("leaves a retracted row blank when the edit lands after the delete", async () => {
      const reader = await fx.player("Reader");
      const messageId = randomUUID();
      const id = await row(reader, messageId);

      await notifications.retractChatMessage(messageId);
      await notifications.updateChatMessagePreview(messageId, "fixed");

      expect(await text(id)).toBe("");
    });

    it("finds the message's rows through an index", async () => {
      const plan = await postgres.transaction(async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");

        const { rows } = await client.query(
          `EXPLAIN UPDATE notifications SET message = 'x'
            WHERE data->>'messageId' = $1
              AND type IN ('ChatMessage', 'MatchChatMessage')
              AND is_read = false
              AND deleted_at IS NULL`,
          [randomUUID()],
        );

        return rows.map((plan) => plan["QUERY PLAN"]).join("\n");
      });

      expect(plan).toContain("notifications_message_id_idx");
    });
  });
});
