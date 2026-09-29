import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import * as webPush from "web-push";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { NotificationsService } from "./../src/notifications/notifications.service";
import { NotificationPreferencesService } from "./../src/notifications/preferences/notification-preferences.service";
import { PushNotificationsService } from "./../src/notifications/push/push-notifications.service";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));

// The audit row, the redis removal and the bell retraction each live in a
// different store, and the unit specs stub all three.
describe("chat moderation (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;
  let notifications: NotificationsService;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1888000000100_chat_message_deletions/up.sql",
    ),
    "utf8",
  );

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

      return {};
    }),
  });

  const pushService = () =>
    new PushNotificationsService(
      logger as any,
      postgres,
      {
        get: (key: string) =>
          key === "app"
            ? { webDomain: "https://example.com" }
            : {
                publicKey: "public-key",
                privateKey: "private-key",
                subject: "https://example.com",
              },
      } as any,
      { add: async () => ({}) } as any,
      {
        getConnection: () => ({
          exists: async () => 0,
          set: async () => "OK",
          get: async (): Promise<string | null> => null,
          ttl: async () => -2,
          del: async () => 1,
          rpush: async () => 1,
          expire: async () => 1,
          multi: () => ({
            lrange() {
              return this;
            },
            del() {
              return this;
            },
            rpush() {
              return this;
            },
            expire() {
              return this;
            },
            exec: async (): Promise<Array<unknown>> => [[null, []]],
          }),
          pipeline: () => {
            const queued: string[] = [];
            return {
              set: () => {},
              hvals: (key: string) => queued.push(key),
              exec: async (): Promise<Array<unknown>> =>
                queued.map(() => [null, []] as [unknown, Array<unknown>]),
            };
          },
          subscribe: async () => 1,
          publish: async () => 1,
          on: () => {},
        }),
      } as any,
    );

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    db = await bootMigratedDb("ChatModerationTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199600000000n);

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
      new PlayerBlocksService(postgres),
    );
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await redis.flushall();
    await postgres.query("DELETE FROM chat_message_deletions");
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM push_subscriptions");
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM players");
  });

  const moderator = async () => {
    const steamId = await fx.player("Mod");
    await postgres.query(
      `UPDATE players SET role = 'moderator' WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return { steam_id: steamId, name: "Mod", role: "moderator" } as any;
  };

  const post = async (
    matchId: string,
    authorSteamId: string,
    message = "something awful",
  ) => {
    const id = randomUUID();
    await redis.hset(
      `chat_match_${matchId}`,
      id,
      JSON.stringify({
        id,
        message,
        timestamp: "2025-01-01T00:00:00.000Z",
        source: "web",
        from: { role: "user", name: "Author", steam_id: authorSteamId },
      }),
    );
    return id;
  };

  const audits = () =>
    postgres.query<
      Array<{
        message_id: string;
        room_type: string;
        room_id: string;
        author_steam_id: string | null;
        message: string;
        message_created_at: Date | null;
        source: string | null;
        deleted_by_steam_id: string | null;
      }>
    >(
      `SELECT message_id::text AS message_id, room_type, room_id,
              author_steam_id::text AS author_steam_id, message,
              message_created_at, source,
              deleted_by_steam_id::text AS deleted_by_steam_id
         FROM chat_message_deletions`,
    );

  describe("deleting", () => {
    it("keeps the evidence and removes only that message", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const matchId = randomUUID();
      const target = await post(matchId, author);
      const other = await post(matchId, author, "fine");

      await expect(
        chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod),
      ).resolves.toEqual({ deleted: true });

      expect(await redis.hexists(`chat_match_${matchId}`, target)).toBe(0);
      expect(await redis.hexists(`chat_match_${matchId}`, other)).toBe(1);

      expect(await audits()).toEqual([
        {
          message_id: target,
          room_type: "match",
          room_id: matchId,
          author_steam_id: author,
          message: "something awful",
          message_created_at: new Date("2025-01-01T00:00:00.000Z"),
          source: "web",
          deleted_by_steam_id: mod.steam_id,
        },
      ]);
    });

    it("still deletes a message whose author has no player row", async () => {
      const mod = await moderator();
      const matchId = randomUUID();
      const target = await post(matchId, "76561199699999999");

      await expect(
        chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod),
      ).resolves.toEqual({ deleted: true });

      const [audit] = await audits();

      expect(audit.author_steam_id).toBeNull();
      expect(audit.message).toBe("something awful");
    });

    it("finishes a delete whose redis removal failed, keeping the first audit", async () => {
      const mod = await moderator();
      const earlier = await moderator();
      const author = await fx.player("Author");
      const matchId = randomUUID();
      const target = await post(matchId, author);

      await postgres.query(
        `INSERT INTO chat_message_deletions
                (message_id, room_type, room_id, author_steam_id, message,
                 deleted_by_steam_id)
              VALUES ($1::uuid, 'match', $2, $3::bigint, 'something awful',
                      $4::bigint)`,
        [target, matchId, author, earlier.steam_id],
      );

      await expect(
        chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod),
      ).resolves.toEqual({ deleted: true });

      expect(await redis.hexists(`chat_match_${matchId}`, target)).toBe(0);

      const rows = await audits();

      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_by_steam_id).toBe(earlier.steam_id);
    });

    it("answers not_found once the message is gone", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const matchId = randomUUID();
      const target = await post(matchId, author);

      await chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod);

      await expect(
        chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotFound });

      expect(await audits()).toHaveLength(1);
    });

    it("tells a deleted message from one that merely expired", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const matchId = randomUUID();
      const deleted = await post(matchId, author);
      const expired = await post(matchId, author, "fine");

      await chat.deleteMessage(ChatLobbyType.Match, matchId, deleted, mod);
      await redis.hdel(`chat_match_${matchId}`, expired);

      expect(await chat["wasDeleted"](deleted)).toBe(true);
      expect(await chat["wasDeleted"](expired)).toBe(false);
    });

    it("keeps the audit when the author's player row goes", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const matchId = randomUUID();
      const target = await post(matchId, author);

      await chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod);
      await postgres.query(`DELETE FROM players WHERE steam_id = $1::bigint`, [
        author,
      ]);

      const [audit] = await audits();

      expect(audit.author_steam_id).toBeNull();
      expect(audit.message).toBe("something awful");
    });
  });

  describe("retracting the bell", () => {
    const chatNotification = async (
      steamId: string,
      entityId: string,
      messageId: string,
      type = "MatchChatMessage",
    ) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO notifications
                (type, title, message, role, steam_id, entity_id, data)
              VALUES ($4, 'Author', 'something awful', 'user',
                      $1::bigint, $2,
                      jsonb_build_object('threadKey', 'chat:' || $2,
                                         'messageId', $3::text))
           RETURNING id::text AS id`,
        [steamId, entityId, messageId, type],
      );
      return row.id;
    };

    // Match chat is off for push by default, so delivery is shown on a room
    // whose category is on.
    const subscribedReader = async () => {
      const reader = await fx.player("Reader");
      await postgres.query(
        `INSERT INTO push_subscriptions (steam_id, endpoint, p256dh, auth)
              VALUES ($1::bigint, $2, 'key', 'auth')`,
        [reader, `https://fcm.googleapis.com/fcm/send/${reader}`],
      );
      return reader;
    };

    const deliver = async (id: string) => {
      const push = pushService();
      await push.loadKeys();
      await push.sendForNotification({ id, type: "ChatMessage" });
    };

    const notification = async (id: string) =>
      (
        await postgres.query<
          Array<{ deleted_at: Date | null; message: string }>
        >(`SELECT deleted_at, message FROM notifications WHERE id = $1::uuid`, [
          id,
        ])
      ).at(0);

    const deletedAt = async (id: string) =>
      (await notification(id))?.deleted_at;

    it("retracts the deleted message's row and no other", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const reader = await fx.player("Reader");
      const matchId = randomUUID();
      const target = await post(matchId, author);
      const other = await post(matchId, author, "fine");

      const retracted = await chatNotification(
        reader,
        `match:${matchId}`,
        target,
      );
      const kept = await chatNotification(reader, `match:${matchId}`, other);

      await chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod);

      expect(await deletedAt(retracted)).toBeInstanceOf(Date);
      expect(await deletedAt(kept)).toBeNull();
    });

    it("takes the text out of the row, so it cannot be read back", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const reader = await fx.player("Reader");
      const matchId = randomUUID();
      const target = await post(matchId, author);
      const id = await chatNotification(reader, `match:${matchId}`, target);

      await chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod);

      expect((await notification(id))?.message).toBe("");
    });

    it("blanks a row the bell had already collapsed, leaving it retired", async () => {
      const reader = await fx.player("Reader");
      const messageId = randomUUID();
      const id = await chatNotification(reader, "tournament:t-1", messageId);
      await postgres.query(
        `UPDATE notifications
            SET deleted_at = now() - interval '1 hour'
          WHERE id = $1::uuid`,
        [id],
      );
      const before = await deletedAt(id);

      await notifications.retractChatMessage(messageId);

      expect(await notification(id)).toEqual({
        deleted_at: before,
        message: "",
      });
    });

    it("retracts a draft lobby's message after it moved into the match", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const reader = await fx.player("Reader");
      const draftId = randomUUID();
      const matchId = randomUUID();
      const target = await post(draftId, author);
      await redis.rename(`chat_match_${draftId}`, `chat_draft_${draftId}`);

      const id = await chatNotification(
        reader,
        `draft:${draftId}`,
        target,
        "ChatMessage",
      );

      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        draftId,
        ChatLobbyType.Match,
        matchId,
      );

      await expect(
        chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod),
      ).resolves.toEqual({ deleted: true });

      expect(await deletedAt(id)).toBeInstanceOf(Date);
    });

    it("leaves a message's rows alone when it expired rather than being deleted", async () => {
      // A 0 TTL drops the field as soon as it is written, and a draft lobby's
      // history moves out from under it into the match. Neither is a delete.
      const author = await fx.player("Author");
      const reader = await fx.player("Reader");
      const matchId = randomUUID();
      const messageId = await post(matchId, author);
      const id = await chatNotification(reader, `match:${matchId}`, messageId);
      await redis.hdel(`chat_match_${matchId}`, messageId);

      const members = jest
        .spyOn(chat, "getLobbyMemberSteamIds")
        .mockResolvedValueOnce([author, reader]);
      const written = jest
        .spyOn(notifications, "notifyPlayers")
        .mockResolvedValueOnce(undefined);

      await chat["notifyLobbyMembers"](
        ChatLobbyType.Match,
        matchId,
        { steam_id: author, name: "Author", role: "user" } as any,
        "Author",
        "something awful",
        messageId,
      );

      members.mockRestore();
      written.mockRestore();

      expect(await notification(id)).toEqual({
        deleted_at: null,
        message: "something awful",
      });
    });

    it("leaves a notification that is not chat alone, whatever its data holds", async () => {
      const reader = await fx.player("Reader");
      const messageId = randomUUID();
      const id = await chatNotification(
        reader,
        "tournament:t-1",
        messageId,
        "MatchStatusChange",
      );

      await notifications.retractChatMessage(messageId);

      expect(await notification(id)).toEqual({
        deleted_at: null,
        message: "something awful",
      });
    });

    it("finds the message's rows through an index", async () => {
      const plan = await postgres.transaction(async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");

        const { rows } = await client.query(
          `EXPLAIN SELECT id FROM notifications
            WHERE data->>'messageId' = $1`,
          [randomUUID()],
        );

        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });

      expect(plan).toContain("notifications_message_id_idx");
    });

    it("drops a retracted row from push delivery", async () => {
      const reader = await subscribedReader();
      const messageId = randomUUID();
      const id = await chatNotification(
        reader,
        "tournament:t-1",
        messageId,
        "ChatMessage",
      );

      await notifications.retractChatMessage(messageId);
      await deliver(id);

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    it("still delivers the row next to it", async () => {
      const reader = await subscribedReader();
      const retracted = randomUUID();
      await chatNotification(
        reader,
        "tournament:t-1",
        retracted,
        "ChatMessage",
      );
      const kept = await chatNotification(
        reader,
        "tournament:t-1",
        randomUUID(),
        "ChatMessage",
      );

      await notifications.retractChatMessage(retracted);
      await deliver(kept);

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe("gag", () => {
    const say = (steamId: string) =>
      chat.sendMessageToChat(
        ChatLobbyType.Tournament,
        "t-1",
        { steam_id: steamId, name: "Someone", role: "user" } as any,
        "hello",
        true,
      );

    const sanction = (
      steamId: string,
      type: string,
      removeAt: string | null = null,
    ) =>
      postgres.query(
        `INSERT INTO player_sanctions
                (player_steam_id, type, remove_sanction_date)
              VALUES ($1::bigint, $2, $3::timestamptz)`,
        [steamId, type, removeAt],
      );

    it.each(["gag", "silence"])("keeps a player under %s out", async (type) => {
      const steamId = await fx.player();
      await sanction(steamId, type);

      await expect(say(steamId)).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.Gagged,
      });
    });

    it("lets a player through once the gag has expired", async () => {
      const steamId = await fx.player();
      await sanction(
        steamId,
        "gag",
        new Date(Date.now() - 60_000).toISOString(),
      );

      await expect(say(steamId)).resolves.toMatchObject({ accepted: true });
    });

    it("does not treat a voice mute as a gag", async () => {
      const steamId = await fx.player();
      await sanction(steamId, "mute");

      await expect(say(steamId)).resolves.toMatchObject({ accepted: true });
    });
  });

  it("re-applies the migration cleanly", async () => {
    await expect(postgres.query(up)).resolves.toBeDefined();
    await expect(postgres.query(up)).resolves.toBeDefined();
  });
});
