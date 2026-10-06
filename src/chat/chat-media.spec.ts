import { ChatService } from "./chat.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { directRoomId } from "./utilities/directRoomId";

const ME = "76561198000000001";
const FRIEND = "76561198000000002";

const ID_1 = "0b7d6c1e-1111-4a2b-9c3d-000000000001";
const ID_2 = "0b7d6c1e-1111-4a2b-9c3d-000000000002";
const ID_3 = "0b7d6c1e-1111-4a2b-9c3d-000000000003";
const ID_4 = "0b7d6c1e-1111-4a2b-9c3d-000000000004";
const ID_5 = "0b7d6c1e-1111-4a2b-9c3d-000000000005";

const descriptor = (id: string) => ({
  id,
  kind: "image",
  name: `${id}.png`,
  mime_type: "image/png",
  size: 1024,
  width: 640,
  height: 360,
});

describe("ChatService attachments and GIFs", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const redis = {
    hset: jest.fn(),
    hget: jest.fn(),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    expire: jest.fn(),
    publish: jest.fn(),
    sendCommand: jest.fn(),
    eval: jest.fn(),
  };

  let gagged: boolean;
  let queries: Array<{ sql: string; bindings: any[] }>;

  const answer = async (sql: string, bindings: any[] = []): Promise<any[]> => {
    queries.push({ sql, bindings });

    if (sql.includes("public.is_gagged")) {
      return [{ gagged }];
    }

    if (sql.includes("INSERT INTO public.direct_messages")) {
      return [{ id: bindings[0] }];
    }

    // Friends, so the room is open to both and every send is allowed.
    if (sql.includes("public.can_view_direct_room")) {
      return [{ allowed: true }];
    }

    if (sql.includes("public.direct_message_refusal($1")) {
      return [{ reason: null }];
    }

    return [];
  };

  const postgres = {
    query: jest.fn(answer),
    transaction: jest.fn(async (work: (client: any) => Promise<unknown>) =>
      work({
        query: async (sql: string, bindings: any[]) => ({
          rows: await postgres.query(sql, bindings),
        }),
      }),
    ),
  };

  const hasura = {
    query: jest.fn(async (query: any) => {
      if (query.lobby_players_by_pk) {
        return { lobby_players_by_pk: { status: "Accepted" } };
      }

      if (query.lobby_players) {
        return {
          lobby_players: [{ steam_id: ME }, { steam_id: FRIEND }],
        };
      }

      if (query.matches_by_pk) {
        return {
          matches_by_pk: {
            is_coach: false,
            is_organizer: false,
            is_in_lineup: true,
          },
        };
      }

      if (query.match_lineups_by_pk) {
        return {
          match_lineups_by_pk: {
            match_id: "m-1",
            coach_steam_id: null,
            is_on_lineup: true,
          },
        };
      }

      if (query.friends) {
        return { friends: [{ status: "Accepted" }] };
      }

      if (query.players_by_pk) {
        return {
          players_by_pk: { steam_id: ME, name: "Someone", role: "user" },
        };
      }

      return {};
    }),
  };

  const playerBlocks = {
    hasBlocked: jest.fn().mockResolvedValue(false),
    isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    blockedBy: jest.fn().mockResolvedValue(new Set()),
    blockedAmong: jest.fn().mockResolvedValue(new Map()),
  };

  const push = {
    sendChatMessage: jest.fn().mockResolvedValue(undefined),
    retractChatMessage: jest.fn().mockResolvedValue(undefined),
    editChatMessage: jest.fn().mockResolvedValue(undefined),
  };

  const attachments = {
    claim: jest.fn(),
    sentBy: jest.fn().mockResolvedValue(false),
    expireMessage: jest.fn().mockResolvedValue(undefined),
    markDeleted: jest.fn().mockResolvedValue(undefined),
    moveRoom: jest.fn().mockResolvedValue(undefined),
  };

  const gifs = {
    enabled: jest.fn(),
  };

  let service: ChatService;

  const player = () =>
    ({
      steam_id: ME,
      name: "Someone",
      role: "user",
      avatar_url: "avatar",
      profile_url: "profile",
    }) as any;

  const stored = (key: string) =>
    redis.hset.mock.calls
      .filter(([hash]) => hash === key)
      .map(([, , value]) => JSON.parse(value));

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const send = (
    type: ChatLobbyType,
    id: string,
    message: string,
    media: { attachments?: unknown; gif?: unknown },
  ) =>
    service.sendMessageToChat(type, id, player(), message, false, "web", media);

  beforeEach(() => {
    jest.clearAllMocks();
    gagged = false;
    queries = [];
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue("OK");
    postgres.query.mockImplementation(answer);
    redis.hget.mockResolvedValue(JSON.stringify({ user: { steam_id: ME } }));
    redis.eval.mockImplementation(async (script: string) =>
      script.includes("INCR") ? 1 : [1, 1],
    );
    attachments.claim.mockImplementation(async (ids: string[]) =>
      ids.map(descriptor),
    );
    gifs.enabled.mockResolvedValue(true);

    service = new ChatService(
      logger as any,
      { connect: jest.fn() } as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      push as any,
      playerBlocks as any,
      attachments as any,
      gifs as any,
    );
  });

  describe("attachments", () => {
    it("sends files to a lobby with no text, carried on the message", async () => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1, ID_2],
        }),
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });

      const [message] = stored("chat_matchmaking_lobby-1");

      expect(message.message).toBe("");
      expect(message.attachments).toEqual([descriptor(ID_1), descriptor(ID_2)]);
    });

    it("claims the files for this sender, this room and this message", async () => {
      const before = Date.now();

      const result = await send(
        ChatLobbyType.MatchMaking,
        "lobby-1",
        "smokes",
        {
          attachments: [ID_1],
        },
      );

      const [ids, claim] = attachments.claim.mock.calls[0];

      expect(ids).toEqual([ID_1]);
      expect(claim).toMatchObject({
        type: ChatLobbyType.MatchMaking,
        roomId: "lobby-1",
        steamId: ME,
        messageId: result.accepted ? result.messageId : "",
      });
      // Lives as long as a lobby keeps its messages, and a little longer so
      // a file is never gone while its message still shows.
      expect(claim.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 3600 * 1000,
      );
      expect(claim.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 3600 * 1000 + 15 * 60 * 1000,
      );
    });

    it("refuses files the sender could not claim, and stores nothing", async () => {
      attachments.claim.mockResolvedValue(null);

      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1],
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Invalid });

      expect(redis.hset).not.toHaveBeenCalled();
      expect(push.sendChatMessage).not.toHaveBeenCalled();
    });

    // A send whose answer was lost is retried with the same files; the first
    // one landed, so the retry says so instead of failing.
    it("says the files were already sent when the same sender sent them here", async () => {
      attachments.claim.mockResolvedValue(null);
      attachments.sentBy.mockResolvedValue(true);

      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1],
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.AlreadySent });

      expect(attachments.sentBy).toHaveBeenCalledWith(
        [ID_1],
        expect.objectContaining({
          steamId: ME,
          type: ChatLobbyType.MatchMaking,
          roomId: "lobby-1",
        }),
      );
    });

    it("says the same of a direct message's files", async () => {
      attachments.claim.mockResolvedValue(null);
      attachments.sentBy.mockResolvedValue(true);

      await expect(
        send(ChatLobbyType.Direct, directRoomId(ME, FRIEND), "", {
          attachments: [ID_1],
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.AlreadySent });
    });

    // Both rooms are relayed into the game server, which shows only text.
    it.each([
      [ChatLobbyType.Match, "m-1"],
      [ChatLobbyType.MatchTeam, "m-1:l-1"],
    ])("keeps %s text-only", async (type, id) => {
      await expect(
        send(type, id, "look", { attachments: [ID_1] }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });

      expect(attachments.claim).not.toHaveBeenCalled();
      expect(redis.hset).not.toHaveBeenCalled();
    });

    it("claims ids in the case postgres hands them back in", async () => {
      await send(ChatLobbyType.MatchMaking, "lobby-1", "", {
        attachments: [ID_1.toUpperCase()],
      });

      expect(attachments.claim.mock.calls[0][0]).toEqual([ID_1]);
      expect(stored("chat_matchmaking_lobby-1")[0].attachments).toEqual([
        descriptor(ID_1),
      ]);
    });

    it("refuses the same file twice, whatever its case", async () => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1, ID_1.toUpperCase()],
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Invalid });
    });

    it("never leaves files claimed by a room message that was not stored", async () => {
      const committed = jest.fn();
      postgres.transaction.mockImplementationOnce(async (work: any) => {
        const result = await work({
          query: async (sql: string, bindings: any[]) => ({
            rows: await postgres.query(sql, bindings),
          }),
        });
        committed();
        return result;
      });
      redis.hset.mockRejectedValueOnce(new Error("redis went away"));

      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1],
        }),
      ).rejects.toThrow("redis went away");

      expect(attachments.claim.mock.calls[0][2]).toBeDefined();
      expect(committed).not.toHaveBeenCalled();
    });

    it("takes the message back out of the room when its expiry cannot be set", async () => {
      redis.sendCommand.mockRejectedValueOnce(new Error("HEXPIRE refused"));

      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1],
        }),
      ).rejects.toThrow("HEXPIRE refused");

      const [key, field] = redis.hset.mock.calls[0];
      expect(redis.hdel).toHaveBeenCalledWith(key, field);
    });

    // The message is already in the room by the time the claim commits, so a
    // commit that fails would leave it pointing at files it never claimed.
    it("takes the message back out of the room when the claim fails to commit", async () => {
      postgres.transaction.mockImplementationOnce(async (work: any) => {
        await work({
          query: async (sql: string, bindings: any[]) => ({
            rows: await postgres.query(sql, bindings),
          }),
        });
        throw new Error("commit failed");
      });

      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1],
        }),
      ).rejects.toThrow("commit failed");

      const [key, field] = redis.hset.mock.calls[0];
      expect(redis.hdel).toHaveBeenCalledWith(key, field);
    });

    it("refuses more than four", async () => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1, ID_2, ID_3, ID_4, ID_5],
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Invalid });

      expect(attachments.claim).not.toHaveBeenCalled();
    });

    it.each([
      ["the same file twice", [ID_1, ID_1]],
      ["something that is not an id", ["../../etc"]],
      ["a number", [5]],
      ["not a list", ID_1],
    ])("refuses %s", async (_, list) => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", { attachments: list }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Invalid });

      expect(attachments.claim).not.toHaveBeenCalled();
    });

    it("still refuses an empty message with nothing attached", async () => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "  ", { attachments: [] }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Invalid });
    });

    it("holds a gagged player to the same rule as their text", async () => {
      gagged = true;

      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          attachments: [ID_1],
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Gagged });

      expect(attachments.claim).not.toHaveBeenCalled();
    });

    it("lets a gagged player attach to a friend, as they may write to one", async () => {
      gagged = true;
      const room = directRoomId(ME, FRIEND);

      await expect(
        send(ChatLobbyType.Direct, room, "", { attachments: [ID_1] }),
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });
    });

    it("claims a direct message's files with the message, for as long as it lasts", async () => {
      const room = directRoomId(ME, FRIEND);

      const result = await send(ChatLobbyType.Direct, room, "", {
        attachments: [ID_1],
      });

      const [ids, claim, client] = attachments.claim.mock.calls[0];

      expect(ids).toEqual([ID_1]);
      expect(claim).toMatchObject({
        type: ChatLobbyType.Direct,
        roomId: room,
        steamId: ME,
        messageId: result.accepted ? result.messageId : "",
        expiresAt: null,
      });
      // Inside the insert's transaction, so a refused insert takes the claim
      // back with it.
      expect(client).toBeDefined();

      const insert = queries.find(({ sql }) =>
        sql.includes("INSERT INTO public.direct_messages"),
      );
      expect(insert.bindings).toContain(JSON.stringify([descriptor(ID_1)]));
    });

    it("pushes 'Attachment' when there is nothing typed", async () => {
      await send(ChatLobbyType.MatchMaking, "lobby-1", "", {
        attachments: [ID_1],
      });
      await flush();

      expect(push.sendChatMessage).toHaveBeenCalledWith(
        [FRIEND],
        expect.objectContaining({ message: "Attachment" }),
      );
    });

    it("counts several attachments in the push", async () => {
      await send(ChatLobbyType.MatchMaking, "lobby-1", "", {
        attachments: [ID_1, ID_2, ID_3],
      });
      await flush();

      expect(push.sendChatMessage).toHaveBeenCalledWith(
        [FRIEND],
        expect.objectContaining({ message: "3 attachments" }),
      );
    });

    it("pushes the text when there is some", async () => {
      await send(ChatLobbyType.MatchMaking, "lobby-1", "smokes", {
        attachments: [ID_1],
      });
      await flush();

      expect(push.sendChatMessage).toHaveBeenCalledWith(
        [FRIEND],
        expect.objectContaining({ message: "smokes" }),
      );
    });
  });

  describe("GIFs", () => {
    const GIF = { id: "abc123", width: 480, height: 270 };

    it("sends a GIF as a reference to GIPHY, not an upload", async () => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", { gif: GIF }),
      ).resolves.toEqual({ accepted: true, messageId: expect.any(String) });

      const [message] = stored("chat_matchmaking_lobby-1");

      expect(message.gif).toEqual(GIF);
      expect(message.attachments).toBeUndefined();
      expect(attachments.claim).not.toHaveBeenCalled();
    });

    it("stores only the id and size, whatever else came with it", async () => {
      await send(ChatLobbyType.MatchMaking, "lobby-1", "", {
        gif: { ...GIF, url: "https://evil.example/pixel.gif" },
      });

      expect(stored("chat_matchmaking_lobby-1")[0].gif).toEqual(GIF);
    });

    it("refuses a GIF when the operator has not set a GIPHY key", async () => {
      gifs.enabled.mockResolvedValue(false);

      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", { gif: GIF }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });

      expect(redis.hset).not.toHaveBeenCalled();
    });

    it("keeps match chat text-only", async () => {
      await expect(
        send(ChatLobbyType.Match, "m-1", "", { gif: GIF }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.NotAllowed });
    });

    it("refuses something that is not a GIPHY id", async () => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          gif: { id: "https://evil.example/x.gif", width: 1, height: 1 },
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Invalid });
    });

    it("refuses a GIF and files in one message", async () => {
      await expect(
        send(ChatLobbyType.MatchMaking, "lobby-1", "", {
          gif: GIF,
          attachments: [ID_1],
        }),
      ).resolves.toEqual({ accepted: false, code: ChatErrorCode.Invalid });
    });

    it("stores a direct message's GIF with it", async () => {
      await send(ChatLobbyType.Direct, directRoomId(ME, FRIEND), "", {
        gif: GIF,
      });

      const insert = queries.find(({ sql }) =>
        sql.includes("INSERT INTO public.direct_messages"),
      );
      expect(insert.bindings).toContain(JSON.stringify(GIF));
    });

    it("pushes 'GIF' when there is nothing typed", async () => {
      await send(ChatLobbyType.MatchMaking, "lobby-1", "", { gif: GIF });
      await flush();

      expect(push.sendChatMessage).toHaveBeenCalledWith(
        [FRIEND],
        expect.objectContaining({ message: "GIF" }),
      );
    });
  });

  describe("who may open a file", () => {
    const row = (overrides: Record<string, unknown> = {}) =>
      ({
        id: ID_1,
        uploader_steam_id: FRIEND,
        room_type: ChatLobbyType.MatchMaking,
        room_id: "lobby-1",
        message_id: "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
        deleted_at: "2026-10-02T12:00:00.000Z",
        ...overrides,
      }) as any;

    // The session still says moderator; the players table says otherwise.
    it("judges by the player's role now, not the one their session holds", async () => {
      await expect(
        service.canViewAttachment(row(), {
          steam_id: ME,
          role: "moderator",
        } as any),
      ).resolves.toBe(false);

      expect(hasura.query).toHaveBeenCalledWith(
        expect.objectContaining({ players_by_pk: expect.anything() }),
      );
    });

    // Every image, every revalidation and every range of a video asks.
    it("looks the player up once a minute, not on every request", async () => {
      const cache = new Map<string, string>();
      redis.get.mockImplementation(
        async (key: string) => cache.get(key) ?? null,
      );
      redis.set.mockImplementation(async (key: string, value: string) => {
        cache.set(key, value);
        return "OK";
      });

      for (let i = 0; i < 3; i++) {
        await service.canViewAttachment(row({ deleted_at: null }), {
          steam_id: ME,
          role: "user",
        } as any);
      }

      expect(
        hasura.query.mock.calls.filter(([query]) => query.players_by_pk),
      ).toHaveLength(1);
      expect(
        redis.set.mock.calls.find(([key]) => String(key).includes(ME)),
      ).toEqual(expect.arrayContaining(["EX", 60]));
    });

    it("lets someone in the room open a sent file", async () => {
      await expect(
        service.canViewAttachment(row({ deleted_at: null }), {
          steam_id: ME,
          role: "user",
        } as any),
      ).resolves.toBe(true);
    });
  });

  describe("removing", () => {
    const MESSAGE_ID = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

    const storeInLobby = (media: Record<string, unknown>) =>
      redis.hget.mockImplementation(async (key: string) =>
        key === "chat_matchmaking_lobby-1"
          ? JSON.stringify({
              id: MESSAGE_ID,
              message: "",
              timestamp: new Date().toISOString(),
              source: "web",
              from: { role: "user", name: "Someone", steam_id: ME },
              ...media,
            })
          : JSON.stringify({ user: { steam_id: ME } }),
      );

    const audit = () =>
      queries.find(({ sql }) =>
        sql.includes("INSERT INTO public.chat_message_deletions"),
      );

    // Posting abuse and deleting it must still leave staff something to see.
    it("keeps a deleted room message's files as evidence, out of the room's sight", async () => {
      storeInLobby({ attachments: [descriptor(ID_1)] });

      await expect(
        service.deleteMessage(
          ChatLobbyType.MatchMaking,
          "lobby-1",
          MESSAGE_ID,
          player(),
        ),
      ).resolves.toEqual({ deleted: true });

      expect(attachments.markDeleted).toHaveBeenCalledWith(
        ChatLobbyType.MatchMaking,
        "lobby-1",
        MESSAGE_ID,
      );
      expect(attachments.expireMessage).not.toHaveBeenCalled();
    });

    it("records a deleted message's files and GIF in the audit", async () => {
      storeInLobby({ attachments: [descriptor(ID_1)] });

      await service.deleteMessage(
        ChatLobbyType.MatchMaking,
        "lobby-1",
        MESSAGE_ID,
        player(),
      );

      expect(audit().sql).toMatch(/attachments, gif/);
      expect(audit().bindings).toContain(JSON.stringify([descriptor(ID_1)]));

      queries = [];
      storeInLobby({ gif: { id: "abc123", width: 480, height: 270 } });

      await service.deleteMessage(
        ChatLobbyType.MatchMaking,
        "lobby-1",
        MESSAGE_ID,
        player(),
      );

      expect(audit().bindings).toContain(
        JSON.stringify({ id: "abc123", width: 480, height: 270 }),
      );
    });

    it("deletes a direct message's files as soon as the message goes", async () => {
      const room = directRoomId(ME, FRIEND);
      postgres.query.mockImplementation(
        async (sql: string, bindings: any[] = []) => {
          queries.push({ sql, bindings });

          if (sql.includes("AS open")) {
            return [{ author: ME, open: true }];
          }

          if (sql.includes("DELETE FROM public.direct_messages")) {
            return [{ id: MESSAGE_ID }];
          }

          if (sql.includes("public.can_view_direct_room")) {
            return [{ allowed: true }];
          }

          return [];
        },
      );

      await expect(
        service.deleteMessage(ChatLobbyType.Direct, room, MESSAGE_ID, player()),
      ).resolves.toEqual({ deleted: true });

      expect(attachments.expireMessage).toHaveBeenCalledWith(
        ChatLobbyType.Direct,
        room,
        MESSAGE_ID,
      );
    });

    // A conversation between friends is not moderated, so there is no
    // evidence to keep.
    it("still deletes a direct message's files straight away", async () => {
      const room = directRoomId(ME, FRIEND);
      postgres.query.mockImplementation(
        async (sql: string, bindings: any[] = []) => {
          queries.push({ sql, bindings });

          if (sql.includes("AS open")) {
            return [{ author: ME, open: true }];
          }

          if (sql.includes("DELETE FROM public.direct_messages")) {
            return [{ id: MESSAGE_ID }];
          }

          return [];
        },
      );

      await service.deleteMessage(
        ChatLobbyType.Direct,
        room,
        MESSAGE_ID,
        player(),
      );

      expect(attachments.markDeleted).not.toHaveBeenCalled();
    });

    // The match chat archive keeps every line the match room holds, moved
    // lines included; their files move with them.
    it("archives a draft's moved lines and moves their files", async () => {
      const line = {
        id: MESSAGE_ID,
        message: "gl",
        timestamp: new Date().toISOString(),
        source: "web",
        attachments: [descriptor(ID_1)],
        from: { role: "user", name: "Someone", steam_id: ME },
      };
      redis.eval.mockImplementation(async (script: string) =>
        script.includes("HGETALL") ? [MESSAGE_ID, JSON.stringify(line)] : 1,
      );

      await service.migrateLobbyMessages(
        ChatLobbyType.Draft,
        "draft-1",
        ChatLobbyType.Match,
        "m-1",
      );

      expect(attachments.moveRoom).toHaveBeenCalledWith(
        ChatLobbyType.Draft,
        "draft-1",
        ChatLobbyType.Match,
        "m-1",
        expect.any(Date),
      );
      expect(
        redis.eval.mock.calls.some(
          ([, , key, id]) => String(key).includes("m-1") && id === MESSAGE_ID,
        ),
      ).toBe(true);
    });

    it("carries a draft's files into the match its chat moves to", async () => {
      redis.eval.mockResolvedValue(0);

      await service.migrateLobbyMessages(
        ChatLobbyType.Draft,
        "draft-1",
        ChatLobbyType.Match,
        "m-1",
      );

      expect(attachments.moveRoom).toHaveBeenCalledWith(
        ChatLobbyType.Draft,
        "draft-1",
        ChatLobbyType.Match,
        "m-1",
        expect.any(Date),
      );
    });
  });
});
