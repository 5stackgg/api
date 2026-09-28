import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
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
      new PlayerBlocksService(postgres),
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
    await postgres.query("DELETE FROM chat_message_edits");
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
      const receipt = `chat_edit_applied:${randomUUID()}`;

      await expect(
        redis.eval(
          script,
          2,
          key(matchId),
          receipt,
          id,
          "stale",
          "replacement",
          60_000,
        ),
      ).resolves.toBe(0);
      await expect(
        redis.eval(
          script,
          2,
          key(matchId),
          receipt,
          randomUUID(),
          "",
          "replacement",
          60_000,
        ),
      ).resolves.toBe(0);

      expect(await redis.hget(key(matchId), id)).toBe(current);
      expect(await expiresAt(matchId, id)).toBe(at);
      expect(await redis.hlen(key(matchId))).toBe(1);
      expect(await redis.exists(receipt)).toBe(0);
    });
  });

  it("never resurrects a message when an edit races its deletion", async () => {
    const user = await author();

    const applied: string[] = [];

    for (let round = 0; round < 25; round++) {
      const matchId = randomUUID();
      const id = await place(matchId, user);

      const [edited, deleted] = await Promise.all([
        edit(matchId, id, user),
        chat.deleteMessage(ChatLobbyType.Match, matchId, id, user),
      ]);

      expect(deleted).toEqual({ deleted: true });
      if (edited.edited === false) {
        expect(edited.code).toBe(ChatErrorCode.NotFound);
      } else {
        applied.push(id);
      }
      expect(await redis.hexists(key(matchId), id)).toBe(0);
    }

    const [{ count }] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM chat_message_deletions
        WHERE deleted_by_steam_id = $1::bigint`,
      [user.steam_id],
    );

    expect(count).toBe("25");

    const audited = await postgres.query<Array<{ message_id: string }>>(
      `SELECT message_id::text AS message_id FROM chat_message_edits`,
    );

    expect(audited.map(({ message_id }) => message_id).sort()).toEqual(
      applied.sort(),
    );
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
    expect(await expiresAt(matchId, id)).toBeGreaterThan(Date.now());
    expect(await redis.exists(`chat_draft_${draftId}`)).toBe(0);

    await expect(
      chat.editMessage(ChatLobbyType.Draft, draftId, id, user, "again"),
    ).resolves.toEqual({ edited: false, code: ChatErrorCode.NotFound });
  });

  describe("an action in the draft room while it moves into the match", () => {
    // Runs the action the first time the move writes into the match room from
    // outside redis, which is the gap a move made of separate calls leaves.
    const midMove = <T>(action: () => Promise<T>) => {
      let running: Promise<T> | undefined;
      const write = redis.hset.bind(redis) as (
        ...args: any[]
      ) => Promise<number>;

      jest.spyOn(redis, "hset").mockImplementation((async (...args: any[]) => {
        running ??= action();
        await running;
        return write(...args);
      }) as any);

      return () => (running ??= action());
    };

    const move = (draftId: string, matchId: string) =>
      chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        draftId,
        ChatLobbyType.Match,
        matchId,
      );

    it("never brings back a message the author deleted", async () => {
      const user = await author();
      const draftId = randomUUID();
      const matchId = randomUUID();
      const id = randomUUID();
      await redis.hset(`chat_draft_${draftId}`, id, written(id, user));

      const deleting = midMove(() =>
        chat.deleteMessage(ChatLobbyType.Draft, draftId, id, user),
      );
      await move(draftId, matchId);
      const { deleted } = await deleting();

      expect(await redis.hexists(key(matchId), id)).toBe(deleted ? 0 : 1);
    });

    it("never loses an edit the author was told had applied", async () => {
      const user = await author();
      const draftId = randomUUID();
      const matchId = randomUUID();
      const id = randomUUID();
      await redis.hset(`chat_draft_${draftId}`, id, written(id, user));

      const editing = midMove(() =>
        chat.editMessage(ChatLobbyType.Draft, draftId, id, user, "fixed"),
      );
      await move(draftId, matchId);
      const { edited } = await editing();

      expect(JSON.parse(await redis.hget(key(matchId), id)).message).toBe(
        edited ? "fixed" : "typo",
      );
    });
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

  describe("the edit audit", () => {
    const up = readFileSync(
      join(
        __dirname,
        "../hasura/migrations/default/1888000000250_chat_message_edits/up.sql",
      ),
      "utf8",
    );

    const down = readFileSync(
      join(
        __dirname,
        "../hasura/migrations/default/1888000000250_chat_message_edits/down.sql",
      ),
      "utf8",
    );

    const edits = (messageId: string) =>
      postgres.query<
        Array<{
          room_type: string;
          room_id: string;
          author: string | null;
          previous_message: string;
          new_message: string;
          message_created_at: Date | null;
          edited_at: Date;
        }>
      >(
        `SELECT room_type, room_id, author_steam_id::text AS author,
                previous_message, new_message, message_created_at, edited_at
           FROM chat_message_edits
          WHERE message_id = $1::uuid
          ORDER BY edited_at`,
        [messageId],
      );

    it("keeps what the message said before each edit", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);
      const { timestamp } = JSON.parse(await redis.hget(key(matchId), id));

      const first = await edit(matchId, id, user, "fixed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await edit(matchId, id, user, "fixed again");

      expect(await edits(id)).toEqual([
        {
          room_type: "match",
          room_id: matchId,
          author: user.steam_id,
          previous_message: "typo",
          new_message: "fixed",
          message_created_at: new Date(timestamp),
          edited_at: new Date(first.edited ? first.edited_at : 0),
        },
        {
          room_type: "match",
          room_id: matchId,
          author: user.steam_id,
          previous_message: "fixed",
          new_message: "fixed again",
          message_created_at: new Date(timestamp),
          edited_at: new Date(second.edited ? second.edited_at : 0),
        },
      ]);
    });

    it("keeps the original when a message is edited and then deleted", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);

      await edit(matchId, id, user, "harmless");
      await chat.deleteMessage(ChatLobbyType.Match, matchId, id, user);

      const [deletion] = await postgres.query<Array<{ message: string }>>(
        `SELECT message FROM chat_message_deletions WHERE message_id = $1::uuid`,
        [id],
      );

      expect(deletion.message).toBe("harmless");
      expect((await edits(id)).map((row) => row.previous_message)).toEqual([
        "typo",
      ]);
    });

    it("records nothing for an edit that never applied", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);

      pauseFirstRead(() => redis.hdel(key(matchId), id));

      await expect(edit(matchId, id, user)).resolves.toEqual({
        edited: false,
        code: ChatErrorCode.NotFound,
      });

      expect(await edits(id)).toEqual([]);
    });

    it("keeps only the edit that applied when another lands in between", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);

      pauseFirstRead(() =>
        chat.editMessage(ChatLobbyType.Match, matchId, id, user, "other tab"),
      );

      await expect(edit(matchId, id, user, "mine")).resolves.toMatchObject({
        edited: true,
      });

      expect(
        (await edits(id)).map(({ previous_message, new_message }) => [
          previous_message,
          new_message,
        ]),
      ).toEqual([
        ["typo", "other tab"],
        ["other tab", "mine"],
      ]);
    });

    // The resend comes after ioredis reconnects, seconds later, so the message
    // may already be gone or edited again by then.
    it.each([
      [
        "deleted",
        (matchId: string, id: string) => redis.hdel(key(matchId), id),
      ],
      [
        "edited again",
        (matchId: string, id: string) =>
          redis.hset(
            key(matchId),
            id,
            JSON.stringify({ id, message: "other" }),
          ),
      ],
    ])(
      "counts a resent swap that already applied as applied, though the message was since %s",
      async (_, meanwhile) => {
        const user = await author();
        const matchId = randomUUID();
        const id = await place(matchId, user);
        const raw = await redis.hget(key(matchId), id);
        const next = JSON.stringify({ ...JSON.parse(raw), message: "fixed" });
        const script = (ChatService as any).EDIT_ROOM_MESSAGE_SCRIPT;
        const receipt = `chat_edit_applied:${randomUUID()}`;
        const swap = () =>
          redis.eval(script, 2, key(matchId), receipt, id, raw, next, 60_000);

        await expect(swap()).resolves.toBe(1);
        expect(await redis.hget(key(matchId), id)).toBe(next);
        expect(await redis.pttl(receipt)).toBeGreaterThan(0);

        await meanwhile(matchId, id);
        const since = await redis.hget(key(matchId), id);

        await expect(swap()).resolves.toBe(1);
        expect(await redis.hget(key(matchId), id)).toBe(since);
      },
    );

    it("outlives the author's player row", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);

      await edit(matchId, id, user);
      await postgres.query(`DELETE FROM players WHERE steam_id = $1::bigint`, [
        user.steam_id,
      ]);

      expect(await edits(id)).toEqual([
        expect.objectContaining({ author: null, previous_message: "typo" }),
      ]);
    });

    it("re-applies the migration cleanly and rolls back", async () => {
      const table = async () =>
        (
          await postgres.query<Array<{ table: string | null }>>(
            `SELECT to_regclass('public.chat_message_edits')::text AS table`,
          )
        )[0].table;

      await expect(postgres.query(up)).resolves.toBeDefined();
      await expect(postgres.query(up)).resolves.toBeDefined();
      await expect(postgres.query(down)).resolves.toBeDefined();
      expect(await table()).toBeNull();
      await expect(postgres.query(down)).resolves.toBeDefined();
      await expect(postgres.query(up)).resolves.toBeDefined();
      expect(await table()).toBe("chat_message_edits");

      const indexes = await postgres.query<Array<{ indexname: string }>>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'chat_message_edits'
          ORDER BY indexname`,
      );

      expect(indexes.map(({ indexname }) => indexname)).toEqual([
        "chat_message_edits_author_idx",
        "chat_message_edits_message_id_idx",
        "chat_message_edits_pkey",
      ]);
    });
  });

  describe("reactions", () => {
    const reactionsKey = (matchId: string, type = "match") =>
      `chat_reactions_${type}_${matchId}`;

    const reactionsExpireAt = async (
      matchId: string,
      id: string,
      type = "match",
    ) =>
      (
        (await redis.call(
          "HPEXPIRETIME",
          reactionsKey(matchId, type),
          "FIELDS",
          1,
          id,
        )) as number[]
      )[0];

    const player = (index: number) =>
      ({
        steam_id: String(76561199620000000n + BigInt(index)),
        name: `Player ${index}`,
        role: "user",
      }) as any;

    const seat = (matchId: string, user: any, type = "match") =>
      redis.hset(
        `chat:${type}:${matchId}`,
        user.steam_id,
        JSON.stringify({ user: { steam_id: user.steam_id } }),
      );

    const react = (
      matchId: string,
      id: string,
      user: any,
      reaction = "heart",
      type = ChatLobbyType.Match,
    ) => chat.toggleReaction(type, matchId, id, reaction, user);

    const stored = async (matchId: string, id: string, type = "match") =>
      JSON.parse((await redis.hget(reactionsKey(matchId, type), id)) ?? "null");

    it("gives reactions the message's own expiry, through an edit", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);

      const sent = await chat.sendMessageToChat(
        ChatLobbyType.Match,
        matchId,
        user,
        "typo",
        true,
      );
      const id = sent.accepted ? sent.messageId : "";
      const expiry = await expiresAt(matchId, id);

      await react(matchId, id, user);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await react(matchId, id, user, "fire");

      expect(expiry).toBeGreaterThan(Date.now());
      expect(await reactionsExpireAt(matchId, id)).toBe(expiry);

      await edit(matchId, id, user);

      expect(await expiresAt(matchId, id)).toBe(expiry);
      expect(await reactionsExpireAt(matchId, id)).toBe(expiry);
      expect(await stored(matchId, id)).toEqual({
        heart: [user.steam_id],
        fire: [user.steam_id],
      });
    });

    it("keeps an expiry to the millisecond, and none for a message with none", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const timed = await place(matchId, user);
      const untimed = await place(matchId, user);
      const at = Date.now() + 123_457;
      await redis.call("HPEXPIREAT", key(matchId), at, "FIELDS", 1, timed);

      await react(matchId, timed, user);
      await react(matchId, untimed, user);

      expect(await reactionsExpireAt(matchId, timed)).toBe(at);
      expect(await reactionsExpireAt(matchId, untimed)).toBe(-1);
    });

    it("keeps the message's expiry when a reaction is taken back and others remain", async () => {
      const user = await author();
      const other = player(1);
      const matchId = randomUUID();
      await seat(matchId, user);
      await seat(matchId, other);
      const id = await place(matchId, user);
      const at = Date.now() + 98_765;
      await redis.call("HPEXPIREAT", key(matchId), at, "FIELDS", 1, id);

      await react(matchId, id, user);
      await react(matchId, id, other);
      await react(matchId, id, other, "fire");
      await react(matchId, id, user);

      expect(await stored(matchId, id)).toEqual({
        heart: [other.steam_id],
        fire: [other.steam_id],
      });
      expect(await reactionsExpireAt(matchId, id)).toBe(at);
    });

    it("lets reactions go when the message does", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const id = await place(matchId, user);
      await redis.call("HPEXPIRE", key(matchId), 150, "FIELDS", 1, id);

      await react(matchId, id, user);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(await redis.exists(reactionsKey(matchId))).toBe(0);
    });

    it("counts twenty players reacting at once exactly", async () => {
      const matchId = randomUUID();
      const id = await place(matchId, await author());
      const players = Array.from({ length: 20 }, (_, index) => player(index));
      await Promise.all(players.map((user) => seat(matchId, user)));

      const on = await Promise.all(
        players.flatMap((user) => [
          react(matchId, id, user, "heart"),
          react(matchId, id, user, "fire"),
        ]),
      );

      expect(on.every((result) => result.toggled)).toBe(true);

      const state = await stored(matchId, id);
      expect([...state.heart].sort()).toEqual(
        players.map(({ steam_id }) => steam_id).sort(),
      );
      expect(state.fire).toHaveLength(20);

      await Promise.all(
        players.flatMap((user) => [
          react(matchId, id, user, "heart"),
          react(matchId, id, user, "fire"),
        ]),
      );

      expect(await redis.hexists(reactionsKey(matchId), id)).toBe(0);
    });

    it("cancels one player's toggles out in pairs, however they race", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const id = await place(matchId, user);

      await Promise.all(
        Array.from({ length: 6 }, () => react(matchId, id, user)),
      );

      expect(await redis.hexists(reactionsKey(matchId), id)).toBe(0);
    });

    // ioredis resends a command whose reply was lost to a reconnect, and a
    // toggle that ran twice would undo itself.
    it("never runs the same toggle twice", async () => {
      const user = await author();
      const matchId = randomUUID();
      const id = await place(matchId, user);
      const receipt = `chat_reaction_applied:${randomUUID()}`;
      const toggle = () =>
        redis.eval(
          (ChatService as any).TOGGLE_ROOM_REACTION_SCRIPT,
          3,
          key(matchId),
          reactionsKey(matchId),
          receipt,
          id,
          "heart",
          user.steam_id,
          "0",
          60_000,
        );

      await expect(toggle()).resolves.toBe(
        JSON.stringify({ heart: [user.steam_id] }),
      );
      await expect(toggle()).resolves.toBe(
        JSON.stringify({ heart: [user.steam_id] }),
      );

      expect(await stored(matchId, id)).toEqual({ heart: [user.steam_id] });
      expect(await redis.pttl(receipt)).toBeGreaterThan(0);
    });

    it("lets a gagged player take a reaction back, but not give one", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const id = await place(matchId, user);

      await react(matchId, id, user, "heart");
      await postgres.query(
        `INSERT INTO player_sanctions (player_steam_id, type)
              VALUES ($1::bigint, 'gag')`,
        [user.steam_id],
      );

      await expect(react(matchId, id, user, "fire")).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.Gagged,
      });
      expect(await stored(matchId, id)).toEqual({ heart: [user.steam_id] });

      await expect(react(matchId, id, user, "heart")).resolves.toEqual({
        toggled: true,
        reactions: {},
      });
      expect(await redis.hexists(reactionsKey(matchId), id)).toBe(0);
    });

    it("hands reactions back in the list's order", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const id = await place(matchId, user);

      for (const reaction of ["sad", "fire", "wow", "thumbsup"]) {
        await react(matchId, id, user, reaction);
      }

      const history = await chat["getMessages"](ChatLobbyType.Match, matchId);

      expect(Object.keys(history[0].reactions)).toEqual([
        "thumbsup",
        "fire",
        "wow",
        "sad",
      ]);
    });

    it("stores steam ids as strings, whole", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const id = await place(matchId, user);

      await react(matchId, id, user);

      expect(await redis.hget(reactionsKey(matchId), id)).toBe(
        JSON.stringify({ heart: [user.steam_id] }),
      );
    });

    it("gives a message that is not there no reactions", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const expired = await place(matchId, user);
      await redis.call("HPEXPIRE", key(matchId), 1, "FIELDS", 1, expired);
      await new Promise((resolve) => setTimeout(resolve, 20));

      for (const id of [randomUUID(), expired]) {
        await expect(react(matchId, id, user)).resolves.toEqual({
          toggled: false,
          code: ChatErrorCode.NotFound,
        });
      }

      expect(await redis.exists(reactionsKey(matchId))).toBe(0);
    });

    it("refuses the ninth toggle in a second, and allows more once it passes", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const id = await place(matchId, user);

      for (let toggle = 0; toggle < ChatService.REACTION_RATE_LIMIT; toggle++) {
        await expect(react(matchId, id, user)).resolves.toMatchObject({
          toggled: true,
        });
      }

      await expect(react(matchId, id, user)).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.RateLimited,
      });

      const ttl = await redis.pttl(`chat:reaction-rate:${user.steam_id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1_000);

      await new Promise((resolve) => setTimeout(resolve, ttl + 50));

      await expect(react(matchId, id, user)).resolves.toMatchObject({
        toggled: true,
      });
    });

    it("takes a message's reactions with it when it is deleted", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const id = await place(matchId, user);
      const kept = await place(matchId, user);

      await react(matchId, id, user);
      await react(matchId, kept, user);

      await expect(
        chat.deleteMessage(ChatLobbyType.Match, matchId, id, user),
      ).resolves.toEqual({ deleted: true });

      expect(await redis.hexists(reactionsKey(matchId), id)).toBe(0);
      expect(await stored(matchId, kept)).toEqual({ heart: [user.steam_id] });
    });

    it("puts each message's reactions in the room's history", async () => {
      const user = await author();
      const matchId = randomUUID();
      await seat(matchId, user);
      const reacted = await place(matchId, user);
      const quiet = await place(matchId, user);

      await react(matchId, reacted, user, "wow");

      const history = await chat["getMessages"](ChatLobbyType.Match, matchId);

      expect(
        Object.fromEntries(history.map(({ id, reactions }) => [id, reactions])),
      ).toEqual({
        [reacted]: { wow: [user.steam_id] },
        [quiet]: {},
      });
    });

    it("carries reactions from a draft into its match in the same step", async () => {
      const organizer = { ...(await author()), role: "match_organizer" };
      const draftId = randomUUID();
      const matchId = randomUUID();
      const id = randomUUID();
      await seat(draftId, organizer, "draft");
      await redis.hset(`chat_draft_${draftId}`, id, written(id, organizer));

      await react(draftId, id, organizer, "sad", ChatLobbyType.Draft);

      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        draftId,
        ChatLobbyType.Match,
        matchId,
      );

      expect(await stored(matchId, id)).toEqual({
        sad: [organizer.steam_id],
      });
      expect(await expiresAt(matchId, id)).toBeGreaterThan(Date.now());
      expect(await reactionsExpireAt(matchId, id)).toBe(
        await expiresAt(matchId, id),
      );
      expect(await redis.exists(reactionsKey(draftId, "draft"))).toBe(0);
      expect(await chat["getMessages"](ChatLobbyType.Match, matchId)).toEqual([
        expect.objectContaining({
          id,
          reactions: { sad: [organizer.steam_id] },
        }),
      ]);

      await seat(draftId, organizer, "draft");

      await expect(
        react(draftId, id, organizer, "sad", ChatLobbyType.Draft),
      ).resolves.toEqual({ toggled: false, code: ChatErrorCode.NotFound });
      expect(await redis.exists(reactionsKey(draftId, "draft"))).toBe(0);
    });

    it("leaves no reactions behind when the match room keeps nothing", async () => {
      const organizer = { ...(await author()), role: "match_organizer" };
      const draftId = randomUUID();
      const matchId = randomUUID();
      const id = randomUUID();
      await seat(draftId, organizer, "draft");
      await redis.hset(`chat_draft_${draftId}`, id, written(id, organizer));
      await react(draftId, id, organizer, "sad", ChatLobbyType.Draft);

      chat.updateChatMessageTTL(ChatLobbyType.Match, 0);

      try {
        await chat.migrateLobbyMessages(
          ChatLobbyType.Draft,
          draftId,
          ChatLobbyType.Match,
          matchId,
        );
      } finally {
        chat.updateChatMessageTTL(ChatLobbyType.Match, 60 * 60);
      }

      expect(await redis.exists(key(matchId))).toBe(0);
      expect(await redis.exists(reactionsKey(matchId))).toBe(0);
      expect(await redis.exists(reactionsKey(draftId, "draft"))).toBe(0);
    });
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

    // A read row stays in the bell, and a collapsed one can be restored by
    // its recipient, so neither may keep the text the author took back.
    it("rewrites every row for that message, read or collapsed", async () => {
      const reader = await fx.player("Reader");
      const messageId = randomUUID();
      const unread = await row(reader, messageId);
      const read = await row(reader, messageId, { is_read: true });
      const collapsed = await row(reader, messageId, { deleted: true });
      const other = await row(reader, randomUUID());

      await notifications.updateChatMessagePreview(messageId, "fixed");

      expect(await text(unread)).toBe("fixed");
      expect(await text(read)).toBe("fixed");
      expect(await text(collapsed)).toBe("fixed");
      expect(await text(other)).toBe("typo");
    });

    it("leaves a row retracted mid-edit blank", async () => {
      const reader = await fx.player("Reader");
      const messageId = randomUUID();
      const id = await row(reader, messageId);
      let pending: Promise<void> = Promise.resolve();

      await postgres.transaction(async (client) => {
        await client.query(
          `UPDATE notifications SET deleted_at = now(), message = ''
            WHERE id = $1::uuid`,
          [id],
        );

        pending = notifications.updateChatMessagePreview(messageId, "fixed");
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      await pending;

      expect(await text(id)).toBe("");
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
              AND message <> ''`,
          [randomUUID()],
        );

        return rows.map((plan) => plan["QUERY PLAN"]).join("\n");
      });

      expect(plan).toContain("notifications_message_id_idx");
    });
  });
});
