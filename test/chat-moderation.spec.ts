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
import {
  ChatPush,
  PushNotificationsService,
} from "./../src/notifications/push/push-notifications.service";
import { chatThreadKey } from "./../src/notifications/push/notification-delivery";
import { rolesAtOrAbove } from "./../src/utilities/isRoleAbove";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));

// The audit row, the redis removal and the retraction of a held push each live
// in a different store, and the unit specs stub all three.
describe("chat moderation (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;
  let push: PushNotificationsService;

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

    push = new PushNotificationsService(
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
      { getConnection: () => redis } as any,
    );
    await push.loadKeys();

    chat = new ChatService(
      logger as any,
      {} as any,
      hasura() as any,
      postgres,
      { getConnection: () => redis } as any,
      push,
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
    await postgres.query("DELETE FROM chat_read_state");
    await postgres.query("DELETE FROM player_blocks");
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

  describe("a push still being held", () => {
    const pushed = () => (webPush.sendNotification as jest.Mock).mock.calls;

    const bodyOf = (call: number) => JSON.parse(pushed()[call][1]).body;

    const subscribedReader = async (role = "user") => {
      const reader = await fx.player("Reader");
      await postgres.query(
        `UPDATE players SET role = $2 WHERE steam_id = $1::bigint`,
        [reader, role],
      );
      await postgres.query(
        `INSERT INTO push_subscriptions (steam_id, endpoint, p256dh, auth)
              VALUES ($1::bigint, $2, 'key', 'auth')`,
        [reader, `https://fcm.googleapis.com/fcm/send/${reader}`],
      );
      return reader;
    };

    // Plain chat rather than match chat, which is off for push by default.
    const message = (
      matchId: string,
      messageId: string,
      senderSteamId: string,
    ): ChatPush => ({
      messageId,
      type: "ChatMessage",
      title: "Author",
      message: "something awful",
      entityId: `match:${matchId}`,
      threadKey: chatThreadKey(ChatLobbyType.Match, matchId),
      threadLabel: "Blue vs Red",
      senderSteamId,
      blockExemptRoles: rolesAtOrAbove("moderator"),
    });

    // The first message buzzes; the rest wait for the window to close.
    const burst = async (
      reader: string,
      matchId: string,
      sender: string,
      messageIds: string[],
    ) => {
      for (const messageId of messageIds) {
        await push.sendChatMessage(
          [reader],
          message(matchId, messageId, sender),
        );
      }

      expect(pushed()).toHaveLength(1);
    };

    const closeWindow = (reader: string, matchId: string) =>
      push.sendPending(reader, chatThreadKey(ChatLobbyType.Match, matchId));

    it("leaves a message a moderator deleted out of the summary", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const matchId = randomUUID();
      const first = await post(matchId, author);
      const target = await post(matchId, author);
      const last = await post(matchId, author);

      await burst(reader, matchId, author, [first, target, last]);
      await chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod);
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(2);
      expect(bodyOf(1)).toBe("2 new messages");
    });

    it("says nothing more when the only message after the first was deleted", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const matchId = randomUUID();
      const first = await post(matchId, author);
      const target = await post(matchId, author);

      await burst(reader, matchId, author, [first, target]);
      await chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod);
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(1);
    });

    it("does not push a message deleted before its push went out", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const matchId = randomUUID();
      const target = await post(matchId, author);

      await chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod);
      await push.sendChatMessage([reader], message(matchId, target, author));

      expect(pushed()).toHaveLength(0);
    });

    it("retracts a draft lobby's message after it moved into the match", async () => {
      const mod = await moderator();
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const draftId = randomUUID();
      const matchId = randomUUID();
      const first = await post(draftId, author);
      const target = await post(draftId, author);
      await redis.rename(`chat_match_${draftId}`, `chat_draft_${draftId}`);

      await burst(reader, matchId, author, [first, target]);
      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        draftId,
        ChatLobbyType.Match,
        matchId,
      );
      await expect(
        chat.deleteMessage(ChatLobbyType.Match, matchId, target, mod),
      ).resolves.toEqual({ deleted: true });
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(1);
    });

    it("shows what an edit made of a held message", async () => {
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const matchId = randomUUID();
      const target = randomUUID();

      await postgres.query(
        `UPDATE players
            SET quiet_hours_start = (now() AT TIME ZONE 'UTC')::time - interval '1 hour',
                quiet_hours_end = (now() AT TIME ZONE 'UTC')::time + interval '1 hour',
                notification_timezone = 'UTC'
          WHERE steam_id = $1::bigint`,
        [reader],
      );
      await push.sendChatMessage([reader], message(matchId, target, author));
      await postgres.query(
        `UPDATE players SET quiet_hours_start = NULL, quiet_hours_end = NULL
          WHERE steam_id = $1::bigint`,
        [reader],
      );

      expect(pushed()).toHaveLength(0);

      await push.editChatMessage(target, "fixed");
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(1);
      expect(bodyOf(0)).toBe("fixed");
    });

    it("drops what a sender the reader has since blocked said", async () => {
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const matchId = randomUUID();

      await burst(reader, matchId, author, [randomUUID(), randomUUID()]);
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
              VALUES ($1::bigint, $2::bigint)`,
        [reader, author],
      );
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(1);
    });

    it("still tells a moderator who blocked the sender about a group room", async () => {
      const author = await fx.player("Author");
      const reader = await subscribedReader("moderator");
      const matchId = randomUUID();

      await burst(reader, matchId, author, [randomUUID(), randomUUID()]);
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
              VALUES ($1::bigint, $2::bigint)`,
        [reader, author],
      );
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(2);
      expect(bodyOf(1)).toBe("2 new messages");
    });

    it("says nothing about held messages the reader has since read", async () => {
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const matchId = randomUUID();

      await burst(reader, matchId, author, [randomUUID(), randomUUID()]);
      await postgres.query(
        `INSERT INTO chat_read_state (steam_id, thread, last_read_at)
              VALUES ($1::bigint, $2, now())`,
        [reader, chatThreadKey(ChatLobbyType.Match, matchId)],
      );
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(1);
    });

    it("ignores a cursor on a different thread", async () => {
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      const matchId = randomUUID();

      await burst(reader, matchId, author, [randomUUID(), randomUUID()]);
      await postgres.query(
        `INSERT INTO chat_read_state (steam_id, thread, last_read_at)
              VALUES ($1::bigint, $2, now())`,
        [reader, chatThreadKey(ChatLobbyType.Match, randomUUID())],
      );
      await closeWindow(reader, matchId);

      expect(pushed()).toHaveLength(2);
    });

    it("pushes nobody who turned chat off", async () => {
      const author = await fx.player("Author");
      const reader = await subscribedReader();
      await postgres.query(
        `INSERT INTO notification_preferences (steam_id, channel, key, enabled)
              VALUES ($1::bigint, 'push', 'chat', false)`,
        [reader],
      );

      await push.sendChatMessage(
        [reader],
        message(randomUUID(), randomUUID(), author),
      );

      expect(pushed()).toHaveLength(0);
    });

    it("writes no notifications row", async () => {
      const author = await fx.player("Author");
      const reader = await subscribedReader();

      await push.sendChatMessage(
        [reader],
        message(randomUUID(), randomUUID(), author),
      );

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM notifications
          WHERE type IN ('ChatMessage', 'MatchChatMessage')`,
      );

      expect(pushed()).toHaveLength(1);
      expect(count).toBe("0");
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
