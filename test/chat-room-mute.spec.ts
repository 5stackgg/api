import { randomUUID } from "crypto";
import * as webPush from "web-push";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";
import { ChatService } from "./../src/chat/chat.service";
import { PlayerBlocksService } from "./../src/player-blocks/player-blocks.service";
import { ChatLobbyType } from "./../src/chat/enums/ChatLobbyTypes";
import {
  ChatPush,
  PushNotificationsService,
} from "./../src/notifications/push/push-notifications.service";
import { chatThreadKey } from "./../src/notifications/push/notification-delivery";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));

// A player's mute and "notify me about" for one room, read by the push gate
// against postgres's clock: a muted room pushes no chatter, a tag breaks
// through unless the room is set to nothing, and a timed mute stops applying
// the moment it runs out, with nothing to clear it.
describe("chat room mute (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let push: PushNotificationsService;
  let chat: ChatService;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const hasura = {
    query: jest.fn(async (query: any) => {
      if (query.players_by_pk) {
        const [player] = await postgres.query<Array<Record<string, string>>>(
          `SELECT steam_id::text AS steam_id, name, role::text AS role,
                  avatar_url, profile_url
             FROM players WHERE steam_id = $1::bigint`,
          [String(query.players_by_pk.__args.steam_id)],
        );
        return { players_by_pk: player ?? null };
      }

      if (query.players) {
        const players = await postgres.query<Array<Record<string, string>>>(
          `SELECT steam_id::text AS steam_id, name, avatar_url
             FROM players WHERE steam_id = ANY($1::bigint[])`,
          [query.players.__args.where.steam_id._in.map(String)],
        );
        return { players };
      }

      if (query.teams_by_pk) {
        const [team] = await postgres.query<Array<{ name: string }>>(
          `SELECT name FROM teams WHERE id = $1::uuid`,
          [query.teams_by_pk.__args.id],
        );
        return { teams_by_pk: team ?? null };
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

    db = await bootMigratedDb("ChatRoomMuteTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196500000000n);

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
      hasura as any,
      postgres,
      { getConnection: () => redis } as any,
      push,
      new PlayerBlocksService(postgres),
      {
        claim: jest.fn(),
        expireMessage: jest.fn(async () => {}),
        markDeleted: jest.fn(async () => {}),
        moveRoom: jest.fn(async () => {}),
      } as any,
      { enabled: jest.fn(async () => false) } as any,
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
    await postgres.query("DELETE FROM chat_room_settings");
    await postgres.query("DELETE FROM chat_read_state");
    await postgres.query("DELETE FROM push_subscriptions");
    await postgres.query("DELETE FROM notification_preferences");
    await postgres.query("DELETE FROM team_invites");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const pushed = () => (webPush.sendNotification as jest.Mock).mock.calls;

  const payloads = () =>
    pushed().map(([subscription, body]) => ({
      endpoint: subscription.endpoint as string,
      ...JSON.parse(body),
    }));

  const endpointOf = (steamId: string) =>
    `https://fcm.googleapis.com/fcm/send/${steamId}`;

  const subscribe = async (steamId: string) => {
    await postgres.query(
      `INSERT INTO push_subscriptions (steam_id, endpoint, p256dh, auth)
            VALUES ($1::bigint, $2, 'key', 'auth')`,
      [steamId, endpointOf(steamId)],
    );
    return steamId;
  };

  const reader = async (name = "Reader") => subscribe(await fx.player(name));

  const setRoom = (
    steamId: string,
    thread: string,
    room: { muted?: boolean; muteMinutes?: number | null; notify?: string },
  ) =>
    postgres.query(
      `INSERT INTO chat_room_settings (steam_id, thread, muted, mute_minutes, notify)
            VALUES ($1::bigint, $2, $3, $4, $5)`,
      [
        steamId,
        thread,
        room.muted ?? false,
        room.muteMinutes ?? null,
        room.notify ?? "all",
      ],
    );

  // Time passing: the end moves into the past without the player touching it.
  const runOut = (steamId: string, thread: string) =>
    postgres.query(
      `UPDATE chat_room_settings
          SET muted_until = now() - interval '1 second'
        WHERE steam_id = $1::bigint AND thread = $2`,
      [steamId, thread],
    );

  const tournamentRoom = () =>
    chatThreadKey(ChatLobbyType.Tournament, randomUUID());

  const line = (
    thread: string,
    senderSteamId: string,
    overrides: Partial<ChatPush> = {},
  ): ChatPush => ({
    messageId: randomUUID(),
    type: "ChatMessage",
    title: "Author",
    message: "anyone up for a scrim?",
    entityId: thread.slice("chat:".length),
    threadKey: thread,
    threadLabel: "Cup",
    senderSteamId,
    blockExemptRoles: [],
    ...overrides,
  });

  const tag = (thread: string, senderSteamId: string) =>
    line(thread, senderSteamId, {
      message: "@Reader you're up",
      mention: true,
      plainType: "ChatMessage",
    });

  describe("what a room's setting lets through", () => {
    it("pushes a room's chatter to a player who left it alone", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();

      await push.sendChatMessage([steamId], line(tournamentRoom(), author));

      expect(pushed()).toHaveLength(1);
    });

    it("pushes no chatter from a muted room", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();
      await setRoom(steamId, room, { muted: true });

      await push.sendChatMessage([steamId], line(room, author));

      expect(pushed()).toHaveLength(0);
    });

    it("still pushes a tag through a mute", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();
      await setRoom(steamId, room, { muted: true });

      await push.sendChatMessage([steamId], tag(room, author));

      expect(payloads()).toEqual([
        expect.objectContaining({ body: "@Reader you're up" }),
      ]);
    });

    it("pushes nothing at all, tags included, from a room set to nothing", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();
      await setRoom(steamId, room, { notify: "nothing" });

      await push.sendChatMessage([steamId], line(room, author));
      await push.sendChatMessage([steamId], tag(room, author));

      expect(pushed()).toHaveLength(0);
    });

    it("pushes only tags from a room set to only tags, even unmuted", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();
      await setRoom(steamId, room, { notify: "mentions" });

      await push.sendChatMessage([steamId], line(room, author));

      expect(pushed()).toHaveLength(0);

      await push.sendChatMessage([steamId], tag(room, author));

      expect(payloads()).toEqual([
        expect.objectContaining({ body: "@Reader you're up" }),
      ]);
    });

    it("holds a timed mute until it runs out", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();
      await setRoom(steamId, room, { muted: true, muteMinutes: 60 });

      await push.sendChatMessage([steamId], line(room, author));

      expect(pushed()).toHaveLength(0);
    });

    it("pushes chatter again the moment a timed mute has run out, with nothing clearing it", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();
      await setRoom(steamId, room, { muted: true, muteMinutes: 15 });
      await runOut(steamId, room);

      await push.sendChatMessage([steamId], line(room, author));

      expect(pushed()).toHaveLength(1);

      const [row] = await postgres.query<Array<{ muted: boolean }>>(
        `SELECT muted FROM chat_room_settings WHERE steam_id = $1::bigint`,
        [steamId],
      );
      expect(row.muted).toBe(true);
    });

    it("mutes the room for the player who muted it and nobody else", async () => {
      const author = await fx.player("Author");
      const muting = await reader("Muting");
      const other = await reader("Other");
      const room = tournamentRoom();
      await setRoom(muting, room, { muted: true });

      await push.sendChatMessage([muting, other], line(room, author));

      expect(payloads().map(({ endpoint }) => endpoint)).toEqual([
        endpointOf(other),
      ]);
    });

    it("leaves every other room of the player's alone", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      await setRoom(steamId, tournamentRoom(), {
        muted: true,
        notify: "nothing",
      });

      await push.sendChatMessage([steamId], line(tournamentRoom(), author));

      expect(pushed()).toHaveLength(1);
    });

    it("mutes a conversation", async () => {
      const friend = await fx.player("Friend");
      const steamId = await reader();
      const room = chatThreadKey(
        ChatLobbyType.Direct,
        [friend, steamId].sort().join(":"),
      );
      await setRoom(steamId, room, { muted: true, muteMinutes: 480 });

      await push.sendChatMessage([steamId], line(room, friend));

      expect(pushed()).toHaveLength(0);
    });

    it("reads a side's team room by the match room that carries it on screen", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const matchId = randomUUID();
      await setRoom(steamId, chatThreadKey(ChatLobbyType.Match, matchId), {
        notify: "nothing",
      });

      await push.sendChatMessage(
        [steamId],
        tag(
          chatThreadKey(ChatLobbyType.MatchTeam, `${matchId}:${randomUUID()}`),
          author,
        ),
      );

      expect(pushed()).toHaveLength(0);
    });
  });

  describe("a burst still being held", () => {
    const closeWindow = (steamId: string, room: string) =>
      push.sendPending(steamId, room);

    it("drops the chatter held when the mute landed", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();

      await push.sendChatMessage([steamId], line(room, author));
      await push.sendChatMessage([steamId], line(room, author));
      await push.sendChatMessage([steamId], line(room, author));
      expect(pushed()).toHaveLength(1);

      await setRoom(steamId, room, { muted: true, muteMinutes: 15 });
      await closeWindow(steamId, room);

      expect(pushed()).toHaveLength(1);
    });

    it("still sums up a held tag once the room is muted", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();

      await push.sendChatMessage([steamId], line(room, author));
      await push.sendChatMessage([steamId], line(room, author));
      await push.sendChatMessage([steamId], tag(room, author));

      await setRoom(steamId, room, { muted: true });
      await closeWindow(steamId, room);

      expect(payloads().at(-1)).toEqual(
        expect.objectContaining({ body: "@Reader you're up" }),
      );
      expect(pushed()).toHaveLength(2);
    });

    it("takes no new chatter into a window while the room is muted", async () => {
      const author = await fx.player("Author");
      const steamId = await reader();
      const room = tournamentRoom();

      await push.sendChatMessage([steamId], tag(room, author));
      await setRoom(steamId, room, { muted: true });
      await push.sendChatMessage([steamId], line(room, author));
      await push.sendChatMessage([steamId], line(room, author));
      await closeWindow(steamId, room);

      expect(pushed()).toHaveLength(1);
    });
  });

  describe("tags in a team's room", () => {
    let team: {
      id: string;
      owner: string;
      starter: string;
      muted: string;
      control: string;
    };

    beforeEach(async () => {
      const { id, owner } = await fx.team();
      team = {
        id,
        owner,
        starter: await fx.player("Starter"),
        muted: await subscribe(await fx.player("Muted")),
        control: await subscribe(await fx.player("Control")),
      };

      for (const steamId of [team.starter, team.muted, team.control]) {
        await runAsUser(postgres, team.owner, "admin", (query) =>
          query(
            `INSERT INTO team_roster (team_id, player_steam_id, status)
             VALUES ($1, $2, 'Starter')`,
            [team.id, steamId],
          ),
        );
      }
    });

    const room = () => chatThreadKey(ChatLobbyType.Team, team.id);

    // Resolves once the message's pushes have all been decided, so a test can
    // tell "not pushed" from "not pushed yet".
    const say = async (text: string, mentions?: string[]) => {
      let notified: Promise<unknown> = Promise.resolve();
      const notify = (chat as any).notifyLobbyMembers;
      jest
        .spyOn(chat as any, "notifyLobbyMembers")
        .mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
          notified = notify.apply(this, args);
          return notified;
        });

      const [player] = await postgres.query<Array<Record<string, string>>>(
        `SELECT steam_id::text AS steam_id, name, role::text AS role
           FROM players WHERE steam_id = $1::bigint`,
        [team.starter],
      );
      await chat.joinMatchLobby(
        {
          id: `client-${randomUUID()}`,
          user: { steam_id: team.starter },
          send: jest.fn(),
          on: jest.fn(),
        } as any,
        ChatLobbyType.Team,
        team.id,
      );
      const result = await chat.sendMessageToChat(
        ChatLobbyType.Team,
        team.id,
        player as any,
        text,
        false,
        "web",
        undefined,
        mentions,
      );

      expect(result).toMatchObject({ accepted: true });
      await notified;

      return result;
    };

    const pushedTo = () => payloads().map(({ endpoint }) => endpoint);

    it("says nothing about a teammate's chatter in a room the player muted", async () => {
      await setRoom(team.muted, room(), { muted: true });

      await say("scrim at 8");

      expect(pushedTo()).toEqual([endpointOf(team.control)]);
    });

    it("lets a teammate's tag break through the mute", async () => {
      await setRoom(team.muted, room(), { muted: true });

      await say("@Muted scrim at 8", [team.muted]);

      expect(payloads()).toEqual([
        expect.objectContaining({
          endpoint: endpointOf(team.control),
          title: expect.not.stringMatching(/mentioned you/),
        }),
        expect.objectContaining({
          endpoint: endpointOf(team.muted),
          title: expect.stringMatching(/^Starter mentioned you/),
          body: "@Muted scrim at 8",
        }),
      ]);
    });

    it("keeps the sender's cooldown free for a tag a room set to nothing swallowed", async () => {
      await setRoom(team.muted, room(), { notify: "nothing" });

      await say("@Muted @Control scrim at 8", [team.muted, team.control]);

      expect(payloads()).toEqual([
        expect.objectContaining({
          endpoint: endpointOf(team.control),
          title: expect.stringMatching(/^Starter mentioned you/),
        }),
      ]);
      expect(
        await redis.exists(
          `notifications:mention:${team.starter}:${team.control}`,
        ),
      ).toBe(1);
      expect(
        await redis.exists(
          `notifications:mention:${team.starter}:${team.muted}`,
        ),
      ).toBe(0);
    });
  });

  describe("when a mute ends", () => {
    const endOf = async (steamId: string) => {
      const [row] = await postgres.query<
        Array<{
          muted: boolean;
          mute_minutes: number | null;
          muted_until: Date | null;
          seconds_left: number | null;
        }>
      >(
        `SELECT muted, mute_minutes, muted_until,
                extract(epoch FROM muted_until - now())::float AS seconds_left
           FROM chat_room_settings
          WHERE steam_id = $1::bigint`,
        [steamId],
      );
      return row;
    };

    // The shape Hasura sends for an upsert: only the columns it was told to
    // update are set again.
    const upsert = (
      steamId: string,
      thread: string,
      values: Record<string, unknown>,
    ) => {
      const columns = Object.keys(values);
      return runAsUser(postgres, steamId, "user", (query) =>
        query(
          `INSERT INTO chat_room_settings (steam_id, thread, ${columns.join(", ")})
                VALUES ($1::bigint, $2, ${columns.map((_, index) => `$${index + 3}`).join(", ")})
           ON CONFLICT (steam_id, thread) DO UPDATE
                SET ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}`,
          [steamId, thread, ...Object.values(values)],
        ),
      );
    };

    it("ends a timed mute by the database's clock, whatever the client's", async () => {
      const steamId = await fx.player();

      await upsert(steamId, tournamentRoom(), {
        muted: true,
        mute_minutes: 60,
      });

      const row = await endOf(steamId);
      expect(row.seconds_left).toBeGreaterThan(3590);
      expect(row.seconds_left).toBeLessThanOrEqual(3600);
    });

    it("never keeps an end time it was handed", async () => {
      const steamId = await fx.player();

      await upsert(steamId, tournamentRoom(), {
        muted: true,
        muted_until: new Date(Date.now() + 5 * 60_000).toISOString(),
      });

      expect(await endOf(steamId)).toMatchObject({
        muted: true,
        muted_until: null,
      });
    });

    it("leaves a mute's end alone when only the level changes", async () => {
      const steamId = await fx.player();
      const room = tournamentRoom();
      await upsert(steamId, room, { muted: true, mute_minutes: 60 });
      const before = (await endOf(steamId)).muted_until;

      await postgres.query("SELECT pg_sleep(0.05)");
      await upsert(steamId, room, { notify: "mentions" });

      expect((await endOf(steamId)).muted_until).toEqual(before);
    });

    it("starts the clock again for a mute picked after the last one ran out", async () => {
      const steamId = await fx.player();
      const room = tournamentRoom();
      await upsert(steamId, room, { muted: true, mute_minutes: 60 });
      await runOut(steamId, room);

      await upsert(steamId, room, { muted: true, mute_minutes: 60 });

      expect((await endOf(steamId)).seconds_left).toBeGreaterThan(3590);
    });

    it("gives a mute until unmuted no end, even over a timed one", async () => {
      const steamId = await fx.player();
      const room = tournamentRoom();
      await upsert(steamId, room, { muted: true, mute_minutes: 60 });

      await upsert(steamId, room, { muted: true, mute_minutes: null });

      expect(await endOf(steamId)).toMatchObject({
        muted: true,
        mute_minutes: null,
        muted_until: null,
      });
    });

    it("forgets the end and the length on unmute", async () => {
      const steamId = await fx.player();
      const room = tournamentRoom();
      await upsert(steamId, room, { muted: true, mute_minutes: 480 });

      await upsert(steamId, room, { muted: false, mute_minutes: null });

      expect(await endOf(steamId)).toMatchObject({
        muted: false,
        mute_minutes: null,
        muted_until: null,
      });
    });
  });

  describe("the table", () => {
    it("starts a room on every message, unmuted", async () => {
      const steamId = await fx.player();
      const room = tournamentRoom();

      await postgres.query(
        `INSERT INTO chat_room_settings (steam_id, thread) VALUES ($1::bigint, $2)`,
        [steamId, room],
      );

      const [row] = await postgres.query<
        Array<{ muted: boolean; muted_until: Date | null; notify: string }>
      >(
        `SELECT muted, muted_until, notify FROM chat_room_settings
          WHERE steam_id = $1::bigint`,
        [steamId],
      );

      expect(row).toEqual({ muted: false, muted_until: null, notify: "all" });
    });

    it("refuses a level it does not know", async () => {
      const steamId = await fx.player();

      await expect(
        setRoom(steamId, tournamentRoom(), { notify: "everything" }),
      ).rejects.toThrow(/chat_room_settings_notify/);
    });

    it("refuses anything that is not a chat thread", async () => {
      const steamId = await fx.player();

      for (const thread of [
        "ChatMessage:direct:1:2",
        "chat:",
        "chat:match:",
        `chat:match:${"x".repeat(200)}`,
      ]) {
        await expect(setRoom(steamId, thread, {})).rejects.toThrow(
          /chat_room_settings_thread/,
        );
      }
    });

    it("refuses an end to a mute that is not on", async () => {
      const steamId = await fx.player();
      const room = tournamentRoom();
      await setRoom(steamId, room, { muted: false });

      await expect(
        postgres.query(
          `UPDATE chat_room_settings SET muted_until = now()
            WHERE steam_id = $1::bigint`,
          [steamId],
        ),
      ).rejects.toThrow(/chat_room_settings_muted_until/);
    });

    it("refuses a mute shorter than a minute or longer than a day", async () => {
      const steamId = await fx.player();

      for (const minutes of [0, -15, 1441]) {
        await expect(
          setRoom(steamId, tournamentRoom(), {
            muted: true,
            muteMinutes: minutes,
          }),
        ).rejects.toThrow(/chat_room_settings_mute_minutes/);
      }
    });

    it("goes with the player", async () => {
      const steamId = await fx.player();
      await setRoom(steamId, tournamentRoom(), { muted: true });

      await postgres.query(`DELETE FROM players WHERE steam_id = $1::bigint`, [
        steamId,
      ]);

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM chat_room_settings`,
      );
      expect(count).toBe("0");
    });
  });
});
