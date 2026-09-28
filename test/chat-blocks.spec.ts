import { randomUUID } from "crypto";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { ChatErrorCode } from "./../src/chat/enums/ChatErrorCode";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import { directRoomId } from "./../src/chat/utilities/directRoomId";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { NotificationsService } from "./../src/notifications/notifications.service";
import { NotificationPreferencesService } from "./../src/notifications/preferences/notification-preferences.service";

// A block hides what the blocked player says from the blocker in group rooms,
// and closes a DM in both directions. Against real Postgres (the block, its
// trigger, the bell) and real redis (rooms, history, fan-out).
describe("chat blocks (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let chat: ChatService;

  let roster: string[];
  let friendshipOverride: boolean;

  let to: jest.SpyInstance;
  let notify: jest.SpyInstance;
  let resend: jest.SpyInstance;
  let deliver: jest.SpyInstance;
  let publish: jest.SpyInstance;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const hasura = {
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

      // Answers the access check, the notification roster and the thread
      // label at once: everyone on `roster` is in the match.
      if (query.matches_by_pk) {
        return {
          matches_by_pk: {
            is_coach: false,
            is_organizer: false,
            is_in_lineup: true,
            organizer_steam_id: null,
            lineup_1: {
              name: "Blue",
              coach_steam_id: null,
              lineup_players: roster.map((steam_id) => ({ steam_id })),
            },
            lineup_2: { name: "Red", coach_steam_id: null, lineup_players: [] },
          },
        };
      }

      if (query.friends) {
        if (friendshipOverride) {
          return { friends: [{ status: "Accepted" }] };
        }

        const [first] = query.friends.__args.where._or;
        const friends = await postgres.query<Array<{ status: string }>>(
          `SELECT status FROM friends
            WHERE status = 'Accepted'
              AND ((player_steam_id = $1::bigint
                    AND other_player_steam_id = $2::bigint)
                OR (player_steam_id = $2::bigint
                    AND other_player_steam_id = $1::bigint))`,
          [
            String(first.player_steam_id._eq),
            String(first.other_player_steam_id._eq),
          ],
        );
        return { friends };
      }

      return {};
    }),
    mutation: jest.fn(async (mutation: any) => {
      const insert = mutation?.insert_notifications;

      if (!insert) {
        return {};
      }

      const returning: Array<{ id: string }> = [];

      for (const object of insert.__args.objects) {
        const [row] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO notifications
                  (type, title, message, role, steam_id, entity_id, in_app, data)
                VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8::jsonb)
             RETURNING id::text AS id`,
          [
            object.type,
            object.title,
            object.message,
            object.role,
            object.steam_id,
            object.entity_id ?? null,
            object.in_app ?? true,
            object.data ? JSON.stringify(object.data) : null,
          ],
        );
        returning.push(row);
      }

      return { insert_notifications: { returning } };
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

    db = await bootMigratedDb("ChatBlocksTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561192820000000n);

    const notifications = new NotificationsService(
      hasura as any,
      postgres,
      logger as any,
      { get: () => ({ webDomain: "https://example.com" }) } as any,
      new NotificationPreferencesService(postgres),
      {
        filterSubscribed: async (): Promise<string[]> => [],
        claimFanOut: jest.fn(),
      } as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
    );

    chat = new ChatService(
      logger as any,
      {} as any,
      hasura as any,
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
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM chat_message_edits");
    await postgres.query("DELETE FROM chat_message_deletions");
    await postgres.query("DELETE FROM direct_messages");
    await postgres.query("DELETE FROM direct_conversations");
    await postgres.query("DELETE FROM players");

    roster = [];
    friendshipOverride = false;

    to = jest.spyOn(chat as any, "to");
    notify = jest.spyOn(chat as any, "notifyLobbyMembers");
    resend = jest.spyOn(chat as any, "resendHistory");
    deliver = jest.spyOn(chat as any, "deliverDirectMessage");
    publish = jest.spyOn(redis, "publish");
  });

  // Every broadcast and notification is fire-and-forget; this waits for the
  // ones started so far.
  const settle = async () => {
    for (let pending = 0; pending !== inFlight().length; ) {
      pending = inFlight().length;
      await Promise.allSettled(inFlight());
    }
  };

  const inFlight = () =>
    [to, notify, resend, deliver].flatMap((spy) =>
      spy.mock.results.map(({ value }) => value),
    );

  const block = (blocker: string, blocked: string) =>
    runAsUser(postgres, blocker, "user", (query) =>
      query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
              VALUES ($1::bigint, $2::bigint)`,
        [blocker, blocked],
      ),
    );

  const unblock = (blocker: string, blocked: string) =>
    runAsUser(postgres, blocker, "user", (query) =>
      query(
        `DELETE FROM player_blocks
          WHERE blocker_steam_id = $1::bigint
            AND blocked_steam_id = $2::bigint`,
        [blocker, blocked],
      ),
    );

  const player = (steamId: string) =>
    ({ steam_id: steamId, name: "Someone", role: "user" }) as any;

  const socket = (steamId: string) => {
    const sent: Array<{ event: string; data: any }> = [];

    return {
      id: randomUUID(),
      user: { steam_id: steamId },
      send: (payload: string) => sent.push(JSON.parse(payload)),
      on: jest.fn(),
      sent,
    } as any;
  };

  const join = async (type: ChatLobbyType, id: string, steamId: string) => {
    const client = socket(steamId);

    await chat.joinMatchLobby(client, type, id);
    await settle();

    return client.sent.find(
      ({ event }: { event: string }) =>
        event === `lobby:${type}:${id}:messages`,
    )?.data.messages as Array<{ message: string }> | undefined;
  };

  const historyOf = async (type: ChatLobbyType, id: string, steamId: string) =>
    (await join(type, id, steamId))?.map(({ message }) => message);

  const say = async (
    type: ChatLobbyType,
    id: string,
    steamId: string,
    text: string,
  ) => {
    const result = await chat.sendMessageToChat(
      type,
      id,
      player(steamId),
      text,
    );
    await settle();

    return result;
  };

  const delivered = (event: string) =>
    publish.mock.calls
      .filter(([channel]) => channel === "send-message-to-steam-id")
      .map(([, payload]) => JSON.parse(payload))
      .filter((sent) => sent.event === event);

  const recipientsOf = (event: string, messageId: string) =>
    delivered(event)
      .filter(({ data }) => data.id === messageId)
      .map(({ steamId }) => steamId)
      .sort();

  const bell = (messageId: string) =>
    postgres.query<
      Array<{ steam_id: string; message: string; deleted: boolean }>
    >(
      `SELECT steam_id::text AS steam_id, message,
              deleted_at IS NOT NULL AS deleted
         FROM notifications
        WHERE data->>'messageId' = $1
        ORDER BY steam_id`,
      [messageId],
    );

  const previews = async (messageId: string) =>
    Object.fromEntries(
      (await bell(messageId)).map(({ steam_id, message }) => [
        steam_id,
        message,
      ]),
    );

  describe("a group room", () => {
    let blocker: string;
    let blocked: string;
    let bystander: string;
    let matchId: string;

    const inMatch = (steamId: string, text: string) =>
      say(ChatLobbyType.Match, matchId, steamId, text);

    const messageIdOf = (result: Awaited<ReturnType<typeof inMatch>>) =>
      result.accepted ? result.messageId : "";

    beforeEach(async () => {
      blocker = await fx.player("Blocker");
      blocked = await fx.player("Blocked");
      bystander = await fx.player("Bystander");
      roster = [blocker, blocked, bystander];
      matchId = randomUUID();

      for (const steamId of roster) {
        await join(ChatLobbyType.Match, matchId, steamId);
      }
    });

    it("hides what the blocked player says from the blocker, live and in history, and from nobody else", async () => {
      const before = messageIdOf(await inMatch(blocked, "before"));

      expect(recipientsOf(`lobby:match:${matchId}:chat`, before)).toEqual(
        [...roster].sort(),
      );

      await block(blocker, blocked);

      const after = messageIdOf(await inMatch(blocked, "after"));

      expect(recipientsOf(`lobby:match:${matchId}:chat`, after)).toEqual(
        [blocked, bystander].sort(),
      );

      expect(await historyOf(ChatLobbyType.Match, matchId, blocker)).toEqual(
        [],
      );
      expect(await historyOf(ChatLobbyType.Match, matchId, bystander)).toEqual([
        "before",
        "after",
      ]);
      expect(await historyOf(ChatLobbyType.Match, matchId, blocked)).toEqual([
        "before",
        "after",
      ]);

      const reply = messageIdOf(await inMatch(blocker, "from the blocker"));

      expect(recipientsOf(`lobby:match:${matchId}:chat`, reply)).toEqual(
        [...roster].sort(),
      );
    });

    it("keeps an edit to a hidden line from the blocker", async () => {
      await block(blocker, blocked);

      const id = messageIdOf(await inMatch(blocked, "typo"));

      await expect(
        chat.editMessage(
          ChatLobbyType.Match,
          matchId,
          id,
          player(blocked),
          "fixed",
        ),
      ).resolves.toMatchObject({ edited: true });
      await settle();

      expect(recipientsOf(`lobby:match:${matchId}:edited`, id)).toEqual(
        [blocked, bystander].sort(),
      );
    });

    it("writes the blocker no bell row for a hidden line, and blanks the ones from before", async () => {
      const before = messageIdOf(await inMatch(blocked, "before"));

      expect(await previews(before)).toEqual({
        [blocker]: "before",
        [bystander]: "before",
      });

      await block(blocker, blocked);

      expect(await bell(before)).toContainEqual({
        steam_id: blocker,
        message: "",
        deleted: true,
      });
      expect(await bell(before)).toContainEqual({
        steam_id: bystander,
        message: "before",
        deleted: false,
      });

      const after = messageIdOf(await inMatch(blocked, "after"));

      expect(await previews(after)).toEqual({ [bystander]: "after" });

      await chat.editMessage(
        ChatLobbyType.Match,
        matchId,
        before,
        player(blocked),
        "before, edited",
      );
      await settle();

      expect(await previews(before)).toEqual({
        [blocker]: "",
        [bystander]: "before, edited",
      });
    });

    it("leaves the bell alone for everyone when the blocker is the one talking", async () => {
      await block(blocker, blocked);

      const id = messageIdOf(await inMatch(blocker, "hello"));

      expect((await bell(id)).map(({ steam_id }) => steam_id)).toEqual(
        [blocked, bystander].sort(),
      );
    });

    it("gives back lines that are still live once unblocked", async () => {
      await block(blocker, blocked);
      await inMatch(blocked, "while blocked");

      expect(await historyOf(ChatLobbyType.Match, matchId, blocker)).toEqual(
        [],
      );

      await unblock(blocker, blocked);

      expect(await historyOf(ChatLobbyType.Match, matchId, blocker)).toEqual([
        "while blocked",
      ]);

      const after = messageIdOf(await inMatch(blocked, "after"));

      expect(recipientsOf(`lobby:match:${matchId}:chat`, after)).toEqual(
        [...roster].sort(),
      );
    });

    it("re-sends a draft's history to each player without what they blocked when it moves into the match", async () => {
      const draftId = randomUUID();

      for (const [steamId, text] of [
        [blocked, "draft from blocked"],
        [bystander, "draft from bystander"],
      ]) {
        await chat.sendMessageToChat(
          ChatLobbyType.Draft,
          draftId,
          player(steamId),
          text,
          true,
        );
      }
      await settle();

      await block(blocker, blocked);

      await chat.migrateLobbyMessages(
        ChatLobbyType.Draft,
        draftId,
        ChatLobbyType.Match,
        matchId,
      );
      await settle();

      const resent = Object.fromEntries(
        delivered(`lobby:match:${matchId}:messages`).map(
          ({ steamId, data }) => [
            steamId,
            data.messages.map(({ message }: { message: string }) => message),
          ],
        ),
      );

      expect(resent).toEqual({
        [blocker]: ["draft from bystander"],
        [blocked]: ["draft from blocked", "draft from bystander"],
        [bystander]: ["draft from blocked", "draft from bystander"],
      });
      expect(await historyOf(ChatLobbyType.Match, matchId, blocker)).toEqual([
        "draft from bystander",
      ]);
    });
  });

  describe("a direct conversation", () => {
    let blocker: string;
    let blocked: string;
    let room: string;
    let fromBlocker: string;
    let fromBlocked: string;

    const rail = async (steamId: string) =>
      (await chat.getDirectConversations(player(steamId))).map(
        ({ roomId }) => roomId,
      );

    beforeEach(async () => {
      blocker = await fx.player("Blocker");
      blocked = await fx.player("Blocked");
      room = directRoomId(blocker, blocked);

      await postgres.query(
        `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
              VALUES ($1::bigint, $2::bigint, 'Accepted')`,
        [blocker, blocked],
      );

      await join(ChatLobbyType.Direct, room, blocker);
      await join(ChatLobbyType.Direct, room, blocked);

      const first = await say(ChatLobbyType.Direct, room, blocker, "hi");
      const second = await say(ChatLobbyType.Direct, room, blocked, "hello");

      fromBlocker = first.accepted ? first.messageId : "";
      fromBlocked = second.accepted ? second.messageId : "";
    });

    it("refuses both sides once one of them blocks", async () => {
      await block(blocker, blocked);
      publish.mockClear();

      for (const steamId of [blocker, blocked]) {
        await expect(
          say(ChatLobbyType.Direct, room, steamId, "still there?"),
        ).resolves.toEqual({
          accepted: false,
          code: ChatErrorCode.NotAllowed,
        });

        expect(await join(ChatLobbyType.Direct, room, steamId)).toBeUndefined();

        await expect(
          chat.editMessage(
            ChatLobbyType.Direct,
            room,
            steamId === blocker ? fromBlocker : fromBlocked,
            player(steamId),
            "edited",
          ),
        ).resolves.toEqual({ edited: false, code: ChatErrorCode.NotAllowed });

        await expect(
          chat.toggleReaction(
            ChatLobbyType.Direct,
            room,
            steamId === blocker ? fromBlocked : fromBlocker,
            "heart",
            player(steamId),
          ),
        ).resolves.toEqual({ toggled: false, code: ChatErrorCode.NotAllowed });

        await expect(
          chat.markThreadRead(ChatLobbyType.Direct, room, player(steamId)),
        ).resolves.toBeNull();
      }

      await settle();

      expect(publish).not.toHaveBeenCalled();

      const [{ count }] = await postgres.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM direct_messages WHERE room_id = $1`,
        [room],
      );
      expect(count).toBe(2);
    });

    it("refuses both sides even while a friendship still reads as accepted", async () => {
      await block(blocked, blocker);
      friendshipOverride = true;

      for (const steamId of [blocker, blocked]) {
        await expect(
          say(ChatLobbyType.Direct, room, steamId, "still there?"),
        ).resolves.toEqual({
          accepted: false,
          code: ChatErrorCode.NotAllowed,
        });
      }
    });

    it("takes the conversation off the blocker's rail only, and gives it back on unblock", async () => {
      expect(await rail(blocker)).toEqual([room]);

      await block(blocker, blocked);

      expect(await rail(blocker)).toEqual([]);
      expect(await rail(blocked)).toEqual([room]);

      await unblock(blocker, blocked);

      expect(await rail(blocker)).toEqual([room]);
    });

    it("blanks the blocker's bell rows for the blocked player's messages, and never the other way", async () => {
      await block(blocker, blocked);

      expect(await bell(fromBlocked)).toEqual([
        { steam_id: blocker, message: "", deleted: true },
      ]);
      expect(await bell(fromBlocker)).toEqual([
        { steam_id: blocked, message: "hi", deleted: false },
      ]);
    });
  });
});
