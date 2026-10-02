import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { PruneDirectMessages } from "./../src/chat/jobs/PruneDirectMessages";
import { directRoomId } from "./../src/chat/utilities/directRoomId";

// Direct messages moved out of redis, so the inbox query, the unread count and
// the retention sweep are all hand-written SQL now. None of it is covered by
// the unit specs, which stub postgres out entirely.
describe("direct messages (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let chat: ChatService;

  const push = {
    sendChatMessage: jest.fn(async () => {}),
    retractChatMessage: jest.fn(async () => {}),
    editChatMessage: jest.fn(async () => {}),
  };

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
    publish: jest.fn(),
    sendCommand: jest.fn(),
    eval: jest.fn(),
  };

  const evalReply = async (script: string) =>
    script.includes("INCR") ? 1 : [1, 1];

  beforeAll(async () => {
    db = await bootMigratedDb("DirectMessagesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199400000000n);

    chat = new ChatService(
      logger as any,
      {} as any,
      // Reading a thread is gated on the same friendship joining is. Who is
      // allowed in is chat.service.spec's subject; this one is about what the
      // SQL does once they are.
      {
        query: jest
          .fn()
          .mockResolvedValue({ friends: [{ status: "Accepted" }] }),
      } as any,
      postgres,
      { getConnection: () => redis } as any,
      push as any,
      new PlayerBlocksService(postgres),
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    redis.eval.mockImplementation(evalReply);
    await postgres.query("DELETE FROM direct_messages");
    await postgres.query("DELETE FROM direct_conversations");
    await postgres.query("DELETE FROM chat_read_state");
    await postgres.query("DELETE FROM players");
  });

  const say = (roomId: string, from: string, message: string) =>
    chat.sendMessageToChat(
      ChatLobbyType.Direct,
      roomId,
      { steam_id: from, name: "Someone", role: "user" } as any,
      message,
      // Membership is the gateway's job; this is about what lands in postgres.
      true,
    );

  it("keeps a conversation across both participants", async () => {
    const me = await fx.player();
    const friend = await fx.player();
    const room = directRoomId(me, friend);

    await say(room, me, "first");
    await say(room, friend, "second");

    const rows = await postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id FROM direct_conversations
        WHERE room_id = $1 ORDER BY steam_id`,
      [room],
    );

    // Both sides, so listing either player's inbox is one indexed read rather
    // than a LIKE over the room id.
    expect(rows.map(({ steam_id }) => steam_id).sort()).toEqual(
      [me, friend].sort(),
    );
  });

  it("counts only what the other person said since the cursor", async () => {
    const me = await fx.player();
    const friend = await fx.player();
    const room = directRoomId(me, friend);

    await say(room, friend, "one");
    await say(room, friend, "two");
    await say(room, me, "my own words");

    const [conversation] = await chat.getDirectConversations({
      steam_id: me,
    } as any);

    expect(conversation.unread).toBe(2);
    expect(conversation.peer.steam_id).toBe(friend);
  });

  it("clears the count once the thread is read", async () => {
    const me = await fx.player();
    const friend = await fx.player();
    const room = directRoomId(me, friend);

    await say(room, friend, "one");
    await chat.markThreadRead(ChatLobbyType.Direct, room, {
      steam_id: me,
    } as any);

    const [conversation] = await chat.getDirectConversations({
      steam_id: me,
    } as any);

    expect(conversation.unread).toBe(0);
  });

  it("stamps messages and cursors from the same clock", async () => {
    // The cursor is written with now(); if a message carries the API pod's
    // clock instead, a pod running milliseconds ahead leaves a just-read
    // message looking unread forever -- and pushing every time.
    const me = await fx.player();
    const friend = await fx.player();
    const room = directRoomId(me, friend);

    await say(room, friend, "one");
    await chat.markThreadRead(ChatLobbyType.Direct, room, {
      steam_id: me,
    } as any);

    const [row] = await postgres.query<Array<{ read_after: boolean }>>(
      `SELECT crs.last_read_at >= dm.created_at AS read_after
         FROM direct_messages dm
         JOIN chat_read_state crs ON crs.steam_id = $1::bigint
        WHERE dm.room_id = $2`,
      [me, room],
    );

    expect(row.read_after).toBe(true);
  });

  it("does not clear the other side's count", async () => {
    const me = await fx.player();
    const friend = await fx.player();
    const room = directRoomId(me, friend);

    await say(room, me, "one");
    await chat.markThreadRead(ChatLobbyType.Direct, room, {
      steam_id: me,
    } as any);

    const [theirs] = await chat.getDirectConversations({
      steam_id: friend,
    } as any);

    expect(theirs.unread).toBe(1);
  });

  it("hands back the conversation in order", async () => {
    const me = await fx.player();
    const friend = await fx.player();
    const room = directRoomId(me, friend);

    await say(room, me, "first");
    await say(room, friend, "second");
    await say(room, me, "third");

    const messages = await chat["getDirectMessages"](room);

    expect(messages.map(({ message }) => message)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(messages.at(0).from.steam_id).toBe(me);
  });

  describe("the rail", () => {
    const bar = async (steamId: string) =>
      (await chat.getDirectConversations({ steam_id: steamId } as any))
        .filter(({ isOpen }) => isOpen)
        .map(({ roomId }) => roomId);

    it("puts a new conversation at the top", async () => {
      const me = await fx.player();
      const first = await fx.player();
      const second = await fx.player();

      await say(directRoomId(me, first), first, "one");
      await say(directRoomId(me, second), second, "two");

      expect(await bar(me)).toEqual([
        directRoomId(me, second),
        directRoomId(me, first),
      ]);
    });

    it("leaves an arranged conversation where it was put", async () => {
      // A message must not reshuffle the bar under the player -- only a
      // conversation that was off it jumps to the top.
      const me = await fx.player();
      const first = await fx.player();
      const second = await fx.player();

      await say(directRoomId(me, first), first, "one");
      await say(directRoomId(me, second), second, "two");
      await say(directRoomId(me, first), first, "three");

      expect(await bar(me)).toEqual([
        directRoomId(me, second),
        directRoomId(me, first),
      ]);
    });

    it("drops the quietest conversation once the bar is full", async () => {
      const me = await fx.player();
      const peers = [];

      for (let index = 0; index < 9; index++) {
        const peer = await fx.player();
        peers.push(peer);
        await say(directRoomId(me, peer), peer, `message ${index}`);
      }

      const open = await bar(me);

      expect(open).toHaveLength(8);
      // The first person to write is the one who has been quiet longest.
      expect(open).not.toContain(directRoomId(me, peers[0]));
      expect(open).toContain(directRoomId(me, peers.at(-1)));
    });

    it("brings a removed conversation back when they write again", async () => {
      const me = await fx.player();
      const peer = await fx.player();
      const room = directRoomId(me, peer);

      await say(room, peer, "one");
      await chat.setConversationOpen(room, { steam_id: me } as any, false);
      expect(await bar(me)).toEqual([]);

      await say(room, peer, "you there?");

      expect(await bar(me)).toEqual([room]);
    });

    it("removes it for one party only", async () => {
      const me = await fx.player();
      const peer = await fx.player();
      const room = directRoomId(me, peer);

      await say(room, peer, "one");
      await chat.setConversationOpen(room, { steam_id: me } as any, false);

      expect(await bar(peer)).toEqual([room]);
    });

    it("ignores a removal from someone not in the room", async () => {
      const me = await fx.player();
      const peer = await fx.player();
      const stranger = await fx.player();
      const room = directRoomId(me, peer);

      await say(room, peer, "one");
      await chat.setConversationOpen(room, { steam_id: stranger } as any, false);

      expect(await bar(me)).toEqual([room]);
    });

    it("writes the order a drag produced", async () => {
      const me = await fx.player();
      const peers = [await fx.player(), await fx.player(), await fx.player()];
      const rooms = peers.map((peer) => directRoomId(me, peer));

      for (const [index, room] of rooms.entries()) {
        await say(room, peers[index], "hi");
      }

      await chat.reorderConversations(rooms, { steam_id: me } as any);

      expect(await bar(me)).toEqual(rooms);
    });

    it("cannot reorder a room the caller is not in", async () => {
      const me = await fx.player();
      const peer = await fx.player();
      const others = [await fx.player(), await fx.player()];
      const mine = directRoomId(me, peer);
      const theirs = directRoomId(others[0], others[1]);

      await say(mine, peer, "hi");
      await say(theirs, others[0], "hi");

      await chat.reorderConversations([theirs, mine], { steam_id: me } as any);

      const [row] = await postgres.query<Array<{ position: number }>>(
        `SELECT position FROM direct_conversations
          WHERE room_id = $1 AND steam_id = $2::bigint`,
        [theirs, others[0]],
      );

      // Their own arrangement is untouched by a request naming their room.
      expect(row.position).toBe(0);
    });
  });

  describe("retention", () => {
    const prune = () => new PruneDirectMessages(logger as any, postgres);

    const setRetention = (days: number) =>
      postgres.query(
        `INSERT INTO settings (name, value)
              VALUES ('public.chat_retention_direct_days', $1)
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
        [String(days)],
      );

    // settings survive the per-test truncation, so a test that changes the
    // window has to hand it back.
    afterEach(() => setRetention(365));

    it("sweeps messages past the retention window", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);

      await say(room, me, "ancient");
      await postgres.query(
        `UPDATE direct_messages SET created_at = now() - interval '400 days'`,
      );
      await say(room, me, "recent");

      await prune().process({} as any);

      const rows = await postgres.query<Array<{ message: string }>>(
        `SELECT message FROM direct_messages`,
      );
      expect(rows.map(({ message }) => message)).toEqual(["recent"]);
    });

    it("drops a conversation whose every message has aged out", async () => {
      // Otherwise an empty thread sits at the top of somebody's inbox forever.
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);

      await say(room, me, "ancient");
      await postgres.query(
        `UPDATE direct_messages SET created_at = now() - interval '400 days'`,
      );

      await prune().process({} as any);

      expect(await chat.getDirectConversations({ steam_id: me } as any)).toEqual(
        [],
      );
    });

    it("keeps everything when retention is off", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);

      await say(room, me, "ancient");
      await postgres.query(
        `UPDATE direct_messages SET created_at = now() - interval '4000 days'`,
      );

      await setRetention(0);
      await prune().process({} as any);

      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM direct_messages`,
      );
      expect(row.count).toBe("1");
    });
  });

  describe("editing and deleting your own messages", () => {
    const sent = async (roomId: string, from: string, message = "typo") => {
      const result = await say(roomId, from, message);
      return result.accepted ? result.messageId : "";
    };

    const stored = async (id: string) =>
      (
        await postgres.query<
          Array<{ message: string; created_at: Date; edited_at: Date | null }>
        >(
          `SELECT message, created_at, edited_at FROM direct_messages
            WHERE id = $1::uuid`,
          [id],
        )
      ).at(0);

    const age = (id: string, minutes: number) =>
      postgres.query(
        `UPDATE direct_messages
            SET created_at = created_at - make_interval(mins => $2::int)
          WHERE id = $1::uuid`,
        [id, minutes],
      );

    const as = (steamId: string) => ({ steam_id: steamId }) as any;

    it("stamps edited_at and leaves created_at alone", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, me);
      const before = await stored(id);

      const result = await chat.editMessage(
        ChatLobbyType.Direct,
        room,
        id,
        as(me),
        "  fixed  ",
      );
      const after = await stored(id);

      expect(before.edited_at).toBeNull();
      expect(after.message).toBe("fixed");
      expect(after.created_at).toEqual(before.created_at);
      expect(result).toEqual({
        edited: true,
        message: "fixed",
        edited_at: after.edited_at.toISOString(),
      });

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM chat_message_edits`,
      );
      expect(count).toBe("0");
    });

    it("shows the edit in history after a reload", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const edited = await sent(room, me);
      await sent(room, friend, "untouched");

      await chat.editMessage(
        ChatLobbyType.Direct,
        room,
        edited,
        as(me),
        "fixed",
      );

      const [first, second] = await chat["getDirectMessages"](room);

      expect(first).toMatchObject({
        id: edited,
        message: "fixed",
        edited_at: (await stored(edited)).edited_at.toISOString(),
      });
      expect(second).not.toHaveProperty("edited_at");
    });

    it("refuses an edit or a delete once the message is older than the window", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, me);
      await age(id, 11);

      await expect(
        chat.editMessage(ChatLobbyType.Direct, room, id, as(me), "fixed"),
      ).resolves.toEqual({ edited: false, code: ChatErrorCode.WindowClosed });
      await expect(
        chat.deleteMessage(ChatLobbyType.Direct, room, id, as(me)),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.WindowClosed });

      expect((await stored(id))?.message).toBe("typo");
    });

    it("refuses the other party", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, me);

      await expect(
        chat.editMessage(ChatLobbyType.Direct, room, id, as(friend), "mine"),
      ).resolves.toEqual({ edited: false, code: ChatErrorCode.NotAllowed });
      await expect(
        chat.deleteMessage(ChatLobbyType.Direct, room, id, as(friend)),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotAllowed });

      expect((await stored(id))?.message).toBe("typo");
    });

    it("answers not_found for a message from another conversation", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const other = await fx.player();
      const id = await sent(directRoomId(me, other), me);

      await expect(
        chat.editMessage(
          ChatLobbyType.Direct,
          directRoomId(me, friend),
          id,
          as(me),
          "fixed",
        ),
      ).resolves.toEqual({ edited: false, code: ChatErrorCode.NotFound });
    });

    it("shows the edit on a push still being held", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, me);

      await chat.editMessage(ChatLobbyType.Direct, room, id, as(me), "fixed");

      expect(push.editChatMessage).toHaveBeenCalledWith(id, "fixed");
    });

    it("deletes within the window and retracts a push still being held", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, me);

      await expect(
        chat.deleteMessage(ChatLobbyType.Direct, room, id, as(me)),
      ).resolves.toEqual({ deleted: true });

      expect(await stored(id)).toBeUndefined();
      expect(push.retractChatMessage).toHaveBeenCalledWith(id);

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM chat_message_deletions`,
      );
      expect(count).toBe("0");
    });

    it("takes a conversation off both rails once its only message is deleted", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, me);

      await chat.deleteMessage(ChatLobbyType.Direct, room, id, as(me));

      expect(await chat.getDirectConversations(as(friend))).toEqual([]);
      expect(await chat.getDirectConversations(as(me))).toEqual([]);
    });

    it("keeps a conversation that still has messages", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      await sent(room, friend, "hello");
      const id = await sent(room, me);

      await chat.deleteMessage(ChatLobbyType.Direct, room, id, as(me));

      expect(
        (await chat.getDirectConversations(as(friend))).map(
          ({ roomId }) => roomId,
        ),
      ).toEqual([room]);
    });

    it("answers not_found once it is gone", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, me);

      await chat.deleteMessage(ChatLobbyType.Direct, room, id, as(me));

      await expect(
        chat.deleteMessage(ChatLobbyType.Direct, room, id, as(me)),
      ).resolves.toEqual({ deleted: false, code: ChatErrorCode.NotFound });
      await expect(
        chat.editMessage(ChatLobbyType.Direct, room, id, as(me), "fixed"),
      ).resolves.toEqual({ edited: false, code: ChatErrorCode.NotFound });
    });
  });

  describe("reactions", () => {
    const as = (steamId: string) => ({ steam_id: steamId }) as any;

    const sent = async (roomId: string, from: string, message = "gg") => {
      const result = await say(roomId, from, message);
      return result.accepted ? result.messageId : "";
    };

    const react = (
      roomId: string,
      id: string,
      steamId: string,
      reaction = "heart",
    ) =>
      chat.toggleReaction(
        ChatLobbyType.Direct,
        roomId,
        id,
        reaction,
        as(steamId),
      );

    const rows = () =>
      postgres.query<Array<{ message_id: string }>>(
        `SELECT message_id::text AS message_id FROM direct_message_reactions`,
      );

    // Reacting is held to the same rule as sending, so both have to be seated
    // in the room.
    beforeEach(() => {
      redis.hget.mockResolvedValue(JSON.stringify({ user: {} }));
    });

    afterEach(() => {
      redis.hget.mockResolvedValue(null);
    });

    it("toggles each player's reactions, oldest first", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, friend);

      await expect(react(room, id, me)).resolves.toEqual({
        toggled: true,
        reactions: { heart: [me] },
      });
      await react(room, id, friend);
      await expect(react(room, id, me, "laugh")).resolves.toEqual({
        toggled: true,
        reactions: { heart: [me, friend], laugh: [me] },
      });
      await expect(react(room, id, me)).resolves.toEqual({
        toggled: true,
        reactions: { heart: [friend], laugh: [me] },
      });
      await react(room, id, friend);
      await expect(react(room, id, me, "laugh")).resolves.toEqual({
        toggled: true,
        reactions: {},
      });

      expect(await rows()).toEqual([]);
    });

    it("cancels one player's racing toggles out in pairs", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);

      // One round loses the race without the row lock only some of the time.
      for (let round = 0; round < 8; round++) {
        await postgres.query("DELETE FROM direct_message_reactions");
        const even = await sent(room, friend, "even");
        const odd = await sent(room, friend, "odd");

        await Promise.all([
          ...Array.from({ length: 6 }, () => react(room, even, me)),
          ...Array.from({ length: 5 }, () => react(room, odd, me)),
        ]);

        expect(await rows()).toEqual([{ message_id: odd }]);
      }
    });

    it("counts both parties toggling every reaction at once exactly", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, friend);

      const results = await Promise.all(
        [me, friend].flatMap((steamId) =>
          ChatService.REACTIONS.map((reaction) =>
            react(room, id, steamId, reaction),
          ),
        ),
      );

      expect(results.every((result) => result.toggled)).toBe(true);

      const [message] = await chat["getMessages"](ChatLobbyType.Direct, room);

      expect(Object.keys(message.reactions)).toEqual([
        ...ChatService.REACTIONS,
      ]);
      for (const reaction of ChatService.REACTIONS) {
        expect([...message.reactions[reaction]].sort()).toEqual(
          [me, friend].sort(),
        );
      }
    });

    it("hands back reactions with the conversation's history", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const reacted = await sent(room, friend, "first");
      const quiet = await sent(room, me, "second");

      await react(room, reacted, me, "fire");

      const history = await chat["getMessages"](ChatLobbyType.Direct, room);

      expect(history.map(({ id, reactions }) => ({ id, reactions }))).toEqual([
        { id: reacted, reactions: { fire: [me] } },
        { id: quiet, reactions: {} },
      ]);
    });

    it("answers not_found for a message from another conversation, and writes nothing", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const other = await fx.player();
      const room = directRoomId(me, friend);
      const elsewhere = await sent(directRoomId(friend, other), friend);

      await expect(react(room, elsewhere, me)).resolves.toEqual({
        toggled: false,
        code: ChatErrorCode.NotFound,
      });
      expect(await rows()).toEqual([]);
    });

    it("goes with the message when its author deletes it", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, friend);
      const kept = await sent(room, me);

      await react(room, id, me);
      await react(room, kept, friend);
      await chat.deleteMessage(ChatLobbyType.Direct, room, id, as(friend));

      expect(await rows()).toEqual([{ message_id: kept }]);
    });

    it("goes with the message when retention sweeps it", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, friend);

      await react(room, id, me);
      await postgres.query(
        `UPDATE direct_messages SET created_at = now() - interval '400 days'`,
      );

      await new PruneDirectMessages(logger as any, postgres).process({} as any);

      expect(await rows()).toEqual([]);
    });

    it("goes with the player who reacted", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await sent(room, friend);

      await react(room, id, me);
      await postgres.query(`DELETE FROM players WHERE steam_id = $1::bigint`, [
        me,
      ]);

      expect(await rows()).toEqual([]);
    });

    describe("the migration", () => {
      const migration = (file: string) =>
        readFileSync(
          join(
            __dirname,
            "../hasura/migrations/default/1888000000300_direct_message_reactions",
            file,
          ),
          "utf8",
        );

      const table = async () =>
        (
          await postgres.query<Array<{ table: string | null }>>(
            `SELECT to_regclass('public.direct_message_reactions')::text AS table`,
          )
        )[0].table;

      it("re-applies cleanly and rolls back", async () => {
        await postgres.query(migration("up.sql"));
        await postgres.query(migration("up.sql"));
        expect(await table()).toBe("direct_message_reactions");

        const indexes = await postgres.query<Array<{ indexname: string }>>(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'direct_message_reactions'
            ORDER BY indexname`,
        );
        expect(indexes.map(({ indexname }) => indexname)).toEqual([
          "direct_message_reactions_pkey",
          "direct_message_reactions_steam_id_idx",
        ]);

        await postgres.query(migration("down.sql"));
        expect(await table()).toBeNull();

        await postgres.query(migration("up.sql"));
        expect(await table()).toBe("direct_message_reactions");
      });
    });
  });

  describe("the edited_at migration", () => {
    const migration = (file: string) =>
      readFileSync(
        join(
          __dirname,
          "../hasura/migrations/default/1888000000200_direct_messages_edited_at",
          file,
        ),
        "utf8",
      );

    const hasColumn = async () =>
      (
        await postgres.query<Array<{ column_name: string }>>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'direct_messages'
              AND column_name = 'edited_at'`,
        )
      ).length === 1;

    it("re-applies cleanly and rolls back", async () => {
      await postgres.query(migration("up.sql"));
      await postgres.query(migration("up.sql"));
      expect(await hasColumn()).toBe(true);

      await postgres.query(migration("down.sql"));
      expect(await hasColumn()).toBe(false);

      await postgres.query(migration("up.sql"));
      expect(await hasColumn()).toBe(true);
    });
  });
});
