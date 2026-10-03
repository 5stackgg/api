import { randomUUID } from "crypto";
import { Readable } from "stream";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { ChatAttachmentsService } from "./../src/chat/chat-attachments.service";
import { ChatGifsService } from "./../src/chat/chat-gifs.service";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { PruneDirectMessages } from "./../src/chat/jobs/PruneDirectMessages";
import { directRoomId } from "./../src/chat/utilities/directRoomId";

const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  uint32(13),
  Buffer.from("IHDR"),
  uint32(640),
  uint32(360),
  Buffer.alloc(40),
]);

describe("chat attachments (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let chat: ChatService;
  let attachments: ChatAttachmentsService;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // What the bucket holds, by key, for whatever uploads and sweeps touch it.
  let objects: Map<string, number>;

  const s3 = {
    createMultipartUpload: jest.fn(async () => `upload-${randomUUID()}`),
    uploadPart: jest.fn(
      async (key: string, _uploadId: string, _part: number, body: Readable) => {
        let length = 0;
        for await (const chunk of body) {
          length += (chunk as Buffer).length;
        }
        objects.set(key, (objects.get(key) ?? 0) + length);
      },
    ),
    completeMultipartUpload: jest.fn(async () => {}),
    abortMultipartUpload: jest.fn(async () => {}),
    stat: jest.fn(async (key: string) => ({
      size: objects.get(key) ?? 0,
      metaData: {},
    })),
    put: jest.fn(async (key: string, body: Buffer) => {
      objects.set(key, body.length);
    }),
    removePrefixStrictly: jest.fn(async (prefix: string) => {
      let removed = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          removed++;
        }
      }
      return removed;
    }),
    listPrefixes: jest.fn(async (): Promise<string[]> => []),
    listStream: jest.fn(async function* () {}),
  };

  const push = {
    sendChatMessage: jest.fn(async () => {}),
    retractChatMessage: jest.fn(async () => {}),
    editChatMessage: jest.fn(async () => {}),
  };

  const redis = {
    hset: jest.fn(),
    hget: jest.fn().mockResolvedValue(null),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
    publish: jest.fn(),
    sendCommand: jest.fn(),
    eval: jest.fn(async (script: string) =>
      script.includes("INCR") ? 1 : [1, 1],
    ),
  };

  beforeAll(async () => {
    db = await bootMigratedDb("ChatAttachmentsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199500000000n);

    attachments = new ChatAttachmentsService(
      logger as any,
      postgres,
      s3 as any,
    );

    chat = new ChatService(
      logger as any,
      {} as any,
      {
        query: jest.fn(async (query: Record<string, any>) => {
          if (query.players_by_pk) {
            return {
              players_by_pk: {
                steam_id: query.players_by_pk.__args.steam_id,
                name: "Someone",
                role: "moderator",
              },
            };
          }

          if (query.lobby_players_by_pk) {
            return { lobby_players_by_pk: { status: "Accepted" } };
          }

          return { friends: [{ status: "Accepted" }] };
        }),
      } as any,
      postgres,
      { getConnection: () => redis } as any,
      push as any,
      new PlayerBlocksService(postgres),
      attachments,
      new ChatGifsService(logger as any, postgres, {
        getConnection: () => redis,
      } as any),
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    objects = new Map();
    await postgres.query("DELETE FROM chat_attachments");
    await postgres.query("DELETE FROM chat_attachment_usage");
    await postgres.query("DELETE FROM chat_message_deletions");
    await postgres.query(
      `DELETE FROM settings WHERE name = 'chat_attachment_daily_mb'`,
    );
    await postgres.query("DELETE FROM direct_messages");
    await postgres.query("DELETE FROM direct_conversations");
    await postgres.query("DELETE FROM players");
  });

  // An image as the composer leaves it: uploaded, not yet sent.
  const uploaded = async (
    steamId: string,
    type: ChatLobbyType,
    roomId: string,
  ): Promise<string> => {
    const created = await attachments.create(steamId, type, roomId, {
      name: "smoke.png",
      size: PNG.length,
      mime_type: "image/png",
      width: 640,
      height: 360,
    });

    if ("code" in created) {
      throw new Error(`refused: ${created.code}`);
    }

    expect(
      await attachments.uploadPart(steamId, created.id, 1, PNG),
    ).toBeNull();

    const completed = await attachments.complete(steamId, created.id);
    if ("code" in completed) {
      throw new Error(`refused: ${completed.code}`);
    }

    return created.id;
  };

  const row = async (id: string) =>
    (
      await postgres.query<
        Array<{
          message_id: string | null;
          expires_at: Date | null;
          storage_prefix: string;
          room_type: string;
          room_id: string;
        }>
      >(
        `SELECT message_id::text AS message_id, expires_at, storage_prefix,
                room_type, room_id
           FROM chat_attachments WHERE id = $1::uuid`,
        [id],
      )
    ).at(0);

  const sendDirect = (roomId: string, from: string, ids: string[], text = "") =>
    chat.sendMessageToChat(
      ChatLobbyType.Direct,
      roomId,
      { steam_id: from, name: "Someone", role: "user" } as any,
      text,
      true,
      "web",
      { attachments: ids },
    );

  describe("uploading", () => {
    it("files an upload under its room's scope and day, and expires it in a day", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");

      const stored = await row(id);

      expect(stored.storage_prefix).toMatch(
        new RegExp(`^chat-attachments/rooms/\\d{4}-\\d{2}-\\d{2}/${id}/$`),
      );
      expect(stored.message_id).toBeNull();
      expect(stored.expires_at.getTime()).toBeGreaterThan(
        Date.now() + 23 * 60 * 60 * 1000,
      );
      expect(objects.has(`${stored.storage_prefix}file`)).toBe(true);
    });

    it("refuses a first part that is not what it claimed to be", async () => {
      const me = await fx.player();
      const created = await attachments.create(
        me,
        ChatLobbyType.MatchMaking,
        "lobby-1",
        { name: "smoke.png", size: 64, mime_type: "image/png" },
      );

      if ("code" in created) {
        throw new Error("refused");
      }

      await expect(
        attachments.uploadPart(
          me,
          created.id,
          1,
          Buffer.concat([Buffer.from("<html>"), Buffer.alloc(58)]),
        ),
      ).resolves.toBe(ChatErrorCode.UnsupportedType);

      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses a part of the wrong length", async () => {
      const me = await fx.player();
      const created = await attachments.create(
        me,
        ChatLobbyType.MatchMaking,
        "lobby-1",
        { name: "smoke.png", size: 64, mime_type: "image/png" },
      );

      if ("code" in created) {
        throw new Error("refused");
      }

      await expect(
        attachments.uploadPart(me, created.id, 1, PNG.subarray(0, 10)),
      ).resolves.toBe(ChatErrorCode.Invalid);
    });

    it("lets nobody but the uploader add to an upload", async () => {
      const me = await fx.player();
      const other = await fx.player();
      const created = await attachments.create(
        me,
        ChatLobbyType.MatchMaking,
        "lobby-1",
        { name: "smoke.png", size: PNG.length, mime_type: "image/png" },
      );

      if ("code" in created) {
        throw new Error("refused");
      }

      await expect(
        attachments.uploadPart(other, created.id, 1, PNG),
      ).resolves.toBe(ChatErrorCode.NotFound);
    });

    it("caps how many unsent uploads one player can hold", async () => {
      const me = await fx.player();

      for (let i = 0; i < ChatAttachmentsService.MAX_PENDING_PER_PLAYER; i++) {
        await attachments.create(me, ChatLobbyType.MatchMaking, "lobby-1", {
          name: "smoke.png",
          size: PNG.length,
          mime_type: "image/png",
        });
      }

      await expect(
        attachments.create(me, ChatLobbyType.MatchMaking, "lobby-1", {
          name: "smoke.png",
          size: PNG.length,
          mime_type: "image/png",
        }),
      ).resolves.toEqual({ code: ChatErrorCode.TooManyPending });
    });

    const start = (steamId: string, size: number) =>
      attachments.create(steamId, ChatLobbyType.MatchMaking, "lobby-1", {
        name: "clip.mp4",
        size,
        mime_type: "video/mp4",
      });

    const setDailyMb = (megabytes: number) =>
      postgres.query(
        `INSERT INTO settings (name, value) VALUES ('chat_attachment_daily_mb', $1)
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
        [String(megabytes)],
      );

    it("holds a player to the operator's daily allowance", async () => {
      const me = await fx.player();
      await setDailyMb(1);

      expect(await start(me, 600 * 1024)).not.toHaveProperty("code");
      await expect(start(me, 600 * 1024)).resolves.toEqual({
        code: ChatErrorCode.QuotaExceeded,
      });
    });

    // Otherwise uploading and removing the same file over and over is free.
    it("counts an upload against the allowance even once it is gone", async () => {
      const me = await fx.player();
      await setDailyMb(1);

      const first = await start(me, 600 * 1024);
      if ("code" in first) {
        throw new Error("refused");
      }
      await attachments.discard(me, first.id);

      await expect(start(me, 600 * 1024)).resolves.toEqual({
        code: ChatErrorCode.QuotaExceeded,
      });
    });

    it("only counts the last day against the allowance", async () => {
      const me = await fx.player();
      await setDailyMb(1);

      await start(me, 600 * 1024);
      await postgres.query(
        `UPDATE chat_attachment_usage SET created_at = now() - interval '25 hours'`,
      );

      expect(await start(me, 600 * 1024)).not.toHaveProperty("code");
    });

    it("never lets a burst of uploads past the caps", async () => {
      const me = await fx.player();
      const attempts = ChatAttachmentsService.MAX_PENDING_PER_PLAYER + 5;

      const results = await Promise.all(
        Array.from({ length: attempts }, () => start(me, 1024)),
      );

      expect(results.filter((result) => !("code" in result))).toHaveLength(
        ChatAttachmentsService.MAX_PENDING_PER_PLAYER,
      );
      expect(
        results.filter(
          (result) =>
            "code" in result && result.code === ChatErrorCode.TooManyPending,
        ),
      ).toHaveLength(5);
    });

    it("refuses an image over the pixel cap, whatever it claimed", async () => {
      const me = await fx.player();
      const huge = Buffer.concat([
        PNG.subarray(0, 16),
        uint32(10_000),
        uint32(5_000),
        Buffer.alloc(40),
      ]);
      const created = await attachments.create(
        me,
        ChatLobbyType.MatchMaking,
        "lobby-1",
        { name: "huge.png", size: huge.length, mime_type: "image/png" },
      );

      if ("code" in created) {
        throw new Error("refused");
      }

      await expect(
        attachments.uploadPart(
          me,
          created.id,
          1,
          Readable.from([huge]),
          huge.length,
        ),
      ).resolves.toBe(ChatErrorCode.TooLarge);
      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("removes an upload taken out of the tray straight away", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      const { storage_prefix } = await row(id);

      await expect(attachments.discard(me, id)).resolves.toBe(true);

      expect(await row(id)).toBeUndefined();
      expect(s3.removePrefixStrictly).toHaveBeenCalledWith(storage_prefix);
    });

    it("never lets a sent file be pulled out from under its message", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");

      await attachments.claim([id], {
        type: ChatLobbyType.MatchMaking,
        roomId: "lobby-1",
        steamId: me,
        messageId: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await expect(attachments.discard(me, id)).resolves.toBe(false);
      expect(await row(id)).toBeDefined();
    });
  });

  describe("claiming", () => {
    const claimAs = (steamId: string, ids: string[], roomId = "lobby-1") =>
      attachments.claim(ids, {
        type: ChatLobbyType.MatchMaking,
        roomId,
        steamId,
        messageId: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      });

    it("hands back the files in the order they were attached", async () => {
      const me = await fx.player();
      const first = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      const second = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");

      const claimed = await claimAs(me, [second, first]);

      expect(claimed.map(({ id }) => id)).toEqual([second, first]);
      expect(claimed[0]).toEqual({
        id: second,
        kind: "image",
        name: "smoke.png",
        mime_type: "image/png",
        size: PNG.length,
        width: 640,
        height: 360,
      });
    });

    it("claims nothing when one file is someone else's", async () => {
      const me = await fx.player();
      const other = await fx.player();
      const mine = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      const theirs = await uploaded(
        other,
        ChatLobbyType.MatchMaking,
        "lobby-1",
      );

      await expect(claimAs(me, [mine, theirs])).resolves.toBeNull();
      expect((await row(mine)).message_id).toBeNull();
    });

    it("claims nothing uploaded for another room", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-2");

      await expect(claimAs(me, [id], "lobby-1")).resolves.toBeNull();
    });

    it("claims nothing still uploading", async () => {
      const me = await fx.player();
      const created = await attachments.create(
        me,
        ChatLobbyType.MatchMaking,
        "lobby-1",
        { name: "smoke.png", size: PNG.length, mime_type: "image/png" },
      );

      if ("code" in created) {
        throw new Error("refused");
      }

      await expect(claimAs(me, [created.id])).resolves.toBeNull();
    });

    it("claims a file only once", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");

      expect(await claimAs(me, [id])).not.toBeNull();
      await expect(claimAs(me, [id])).resolves.toBeNull();
    });

    it("knows a file is already sent by its own sender, in this room", async () => {
      const me = await fx.player();
      const other = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      const claim = {
        type: ChatLobbyType.MatchMaking,
        roomId: "lobby-1",
        steamId: me,
        messageId: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      };

      await expect(attachments.sentBy([id], claim)).resolves.toBe(false);

      await attachments.claim([id], claim);

      await expect(attachments.sentBy([id], claim)).resolves.toBe(true);
      await expect(
        attachments.sentBy([id], { ...claim, steamId: other }),
      ).resolves.toBe(false);
      await expect(
        attachments.sentBy([id], { ...claim, roomId: "lobby-2" }),
      ).resolves.toBe(false);
    });

    it("claims nothing that has expired", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      await postgres.query(
        `UPDATE chat_attachments SET expires_at = now() - interval '1 minute'`,
      );

      await expect(claimAs(me, [id])).resolves.toBeNull();
    });
  });

  describe("direct messages", () => {
    it("keeps a direct message's files with it in history", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await uploaded(me, ChatLobbyType.Direct, room);

      const sent = await sendDirect(room, me, [id]);
      expect(sent.accepted).toBe(true);

      const [message] = await chat["getMessages"](ChatLobbyType.Direct, room);

      expect(message.message).toBe("");
      expect(message.attachments).toEqual([
        expect.objectContaining({ id, kind: "image", mime_type: "image/png" }),
      ]);
      // Lives as long as the message does, however long that is.
      expect((await row(id)).expires_at).toBeNull();
    });

    it("keeps a direct message's GIF with it in history", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      await postgres.query(
        `INSERT INTO settings (name, value) VALUES ('giphy_api_key', 'k')
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      );

      await chat.sendMessageToChat(
        ChatLobbyType.Direct,
        room,
        { steam_id: me, name: "Someone", role: "user" } as any,
        "",
        true,
        "web",
        { gif: { id: "abc123", width: 480, height: 270 } },
      );

      await postgres.query(`DELETE FROM settings WHERE name = 'giphy_api_key'`);

      const [message] = await chat["getMessages"](ChatLobbyType.Direct, room);

      expect(message.gif).toEqual({ id: "abc123", width: 480, height: 270 });
    });

    it("takes the claim back when the message is not stored", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await uploaded(me, ChatLobbyType.Direct, room);
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1::bigint, $2::bigint)`,
        [friend, me],
      );

      await expect(sendDirect(room, me, [id])).resolves.toEqual({
        accepted: false,
        code: ChatErrorCode.NotAllowed,
      });

      expect((await row(id)).message_id).toBeNull();
    });

    it("deletes a direct message's files when retention sweeps the message", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const old = await uploaded(me, ChatLobbyType.Direct, room);
      const recent = await uploaded(me, ChatLobbyType.Direct, room);

      await sendDirect(room, me, [old]);
      await postgres.query(
        `UPDATE direct_messages SET created_at = now() - interval '400 days'`,
      );
      await sendDirect(room, me, [recent]);

      const { storage_prefix } = await row(old);

      await new PruneDirectMessages(
        logger as any,
        postgres,
        attachments,
      ).process({} as any);

      expect(await row(old)).toBeUndefined();
      expect(s3.removePrefixStrictly).toHaveBeenCalledWith(storage_prefix);
      expect(await row(recent)).toBeDefined();
    });

    it("deletes a direct message's files when its author deletes it", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await uploaded(me, ChatLobbyType.Direct, room);
      const sent = await sendDirect(room, me, [id]);
      const { storage_prefix } = await row(id);

      await expect(
        chat.deleteMessage(
          ChatLobbyType.Direct,
          room,
          sent.accepted ? sent.messageId : "",
          { steam_id: me, name: "Someone", role: "user" } as any,
        ),
      ).resolves.toEqual({ deleted: true });

      expect(await row(id)).toBeUndefined();
      expect(s3.removePrefixStrictly).toHaveBeenCalledWith(storage_prefix);
    });

    it("marks the files of a deleted player's messages for removal", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await uploaded(me, ChatLobbyType.Direct, room);
      await sendDirect(room, me, [id]);

      await postgres.query(`DELETE FROM players WHERE steam_id = $1::bigint`, [
        me,
      ]);

      const stored = await row(id);
      expect(stored.expires_at.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("expiry", () => {
    it("removes uploads never sent once their day is up", async () => {
      const me = await fx.player();
      const unsent = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      const fresh = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      await postgres.query(
        `UPDATE chat_attachments SET expires_at = now() - interval '1 second'
          WHERE id = $1::uuid`,
        [unsent],
      );

      await expect(attachments.removeExpired()).resolves.toBe(1);

      expect(await row(unsent)).toBeUndefined();
      expect(await row(fresh)).toBeDefined();
    });

    it("never times out a sent direct message's file on its own", async () => {
      const me = await fx.player();
      const friend = await fx.player();
      const room = directRoomId(me, friend);
      const id = await uploaded(me, ChatLobbyType.Direct, room);
      await sendDirect(room, me, [id]);

      await attachments.removeExpired();

      expect(await row(id)).toBeDefined();
    });

    const sendToLobby = async (steamId: string, ids: string[]) => {
      const sent = await chat.sendMessageToChat(
        ChatLobbyType.MatchMaking,
        "lobby-1",
        { steam_id: steamId, name: "Someone", role: "user" } as any,
        "",
        true,
        "web",
        { attachments: ids },
      );

      if (sent.accepted === false) {
        throw new Error(`refused: ${sent.code}`);
      }

      return sent.messageId;
    };

    it("keeps a deleted lobby message's files as evidence until they expire", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.MatchMaking, "lobby-1");
      const messageId = await sendToLobby(me, [id]);
      const [stored] = redis.hset.mock.calls.at(-1).slice(2);

      redis.hget.mockImplementation(async (key: string, field: string) =>
        key === "chat_matchmaking_lobby-1" && field === messageId
          ? stored
          : null,
      );

      await expect(
        chat.deleteMessage(ChatLobbyType.MatchMaking, "lobby-1", messageId, {
          steam_id: me,
          name: "Someone",
          role: "moderator",
        } as any),
      ).resolves.toEqual({ deleted: true });

      redis.hget.mockResolvedValue(null);

      const [audit] = await postgres.query<
        Array<{ attachments: Array<{ id: string }> | null }>
      >(`SELECT attachments FROM chat_message_deletions`);
      expect(audit.attachments.map(({ id: kept }) => kept)).toEqual([id]);

      const kept = await attachments.find(id);
      expect(kept?.deleted_at).not.toBeNull();
      expect(s3.removePrefixStrictly).not.toHaveBeenCalled();

      await attachments.removeExpired();
      expect(await attachments.find(id)).toBeDefined();

      await postgres.query(
        `UPDATE chat_attachments SET expires_at = now() - interval '1 second'`,
      );
      await attachments.removeExpired();

      expect(await row(id)).toBeUndefined();
    });

    it("never brings a deleted or due file back by moving it to the match", async () => {
      const me = await fx.player();
      const deleted = await uploaded(me, ChatLobbyType.Draft, "draft-1");
      const due = await uploaded(me, ChatLobbyType.Draft, "draft-1");

      for (const id of [deleted, due]) {
        await attachments.claim([id], {
          type: ChatLobbyType.Draft,
          roomId: "draft-1",
          steamId: me,
          messageId: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        });
      }

      await postgres.query(
        `UPDATE chat_attachments SET deleted_at = now() WHERE id = $1::uuid`,
        [deleted],
      );
      await postgres.query(
        `UPDATE chat_attachments SET expires_at = now() - interval '1 second'
          WHERE id = $1::uuid`,
        [due],
      );

      await attachments.moveRoom(
        ChatLobbyType.Draft,
        "draft-1",
        ChatLobbyType.Match,
        "m-1",
        new Date(Date.now() + 3600_000),
      );

      for (const id of [deleted, due]) {
        const stored = await row(id);
        expect(stored.room_type).toBe("draft");
        expect(stored.expires_at.getTime()).toBeLessThan(Date.now() + 61_000);
      }
    });

    it("moves a draft's files into its match, and keeps them as long as the match chat", async () => {
      const me = await fx.player();
      const id = await uploaded(me, ChatLobbyType.Draft, "draft-1");
      await attachments.claim([id], {
        type: ChatLobbyType.Draft,
        roomId: "draft-1",
        steamId: me,
        messageId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const later = new Date(Date.now() + 3600_000);
      await attachments.moveRoom(
        ChatLobbyType.Draft,
        "draft-1",
        ChatLobbyType.Match,
        "m-1",
        later,
      );

      const moved = await row(id);
      expect(moved).toMatchObject({ room_type: "match", room_id: "m-1" });
      expect(moved.expires_at.getTime()).toBe(later.getTime());
    });
  });
});
