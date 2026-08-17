import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
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
    eval: jest.fn().mockResolvedValue([1, 1]),
  };

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
      { notifyPlayers: jest.fn(), markConversationRead: jest.fn() } as any,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await postgres.query("DELETE FROM direct_messages");
    await postgres.query("DELETE FROM direct_conversations");
    await postgres.query("DELETE FROM chat_read_state");
    await postgres.query("DELETE FROM notifications");
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
});
