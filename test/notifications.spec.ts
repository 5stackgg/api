import * as webPush from "web-push";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { TournamentReminders } from "./../src/matches/jobs/TournamentReminders";
import { NotificationsService } from "./../src/notifications/notifications.service";
import { NotificationPreferencesService } from "./../src/notifications/preferences/notification-preferences.service";
import { PushNotificationsService } from "./../src/notifications/push/push-notifications.service";
import { isAllowedPushEndpoint } from "./../src/notifications/push/push-endpoint";

// The delivery path is exercised for real below, so the transport is the one
// thing that has to be stubbed -- otherwise the recipient tests would POST to
// Google's push service.
jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));

// Runs the raw SQL behind the notification work against a real Postgres.
// Everything here is hand-written SQL rather than generated queries, so a
// reserved word or a bad cast would otherwise only surface in production.
describe("notifications (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeAll(async () => {
    db = await bootMigratedDb("NotificationsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199300000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM notification_preferences");
    await postgres.query("DELETE FROM push_subscriptions");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const preferences = () => new NotificationPreferencesService(postgres);

  // notifyPlayers inserts through Hasura, so the dedupe assertions below only
  // mean anything if the mutation actually lands in the table.
  const hasuraWritingToPostgres = () => ({
    query: jest.fn().mockResolvedValue({ settings_by_pk: null }),
    mutation: jest.fn(async (mutation: any) => {
      const insert = mutation?.insert_notifications;

      if (!insert) {
        return {};
      }

      for (const object of insert.__args.objects) {
        await postgres.query(
          `INSERT INTO notifications (type, title, message, role, steam_id, entity_id, in_app)
                VALUES ($1, $2, $3, $4, $5::bigint, $6, $7)`,
          [
            object.type,
            object.title,
            object.message,
            object.role,
            object.steam_id,
            object.entity_id ?? null,
            object.in_app ?? true,
          ],
        );
      }

      return { insert_notifications: { affected_rows: insert.length } };
    }),
  });

  // notifyPlayers asks who could be pushed to at all, so this answers from the
  // real table rather than a fixed list.
  const pushNotifications = () => ({
    add: jest.fn(),
    claimFanOut: jest.fn(),
    filterSubscribed: async (steamIds: Array<string>) =>
      (
        await postgres.query<Array<{ steam_id: string }>>(
          `SELECT DISTINCT steam_id::text AS steam_id
             FROM push_subscriptions
            WHERE steam_id = ANY($1::bigint[])`,
          [steamIds],
        )
      ).map((row) => row.steam_id),
  });

  const notifications = () =>
    new NotificationsService(
      hasuraWritingToPostgres() as any,
      postgres,
      logger as any,
      { get: () => ({ webDomain: "https://example.com" }) } as any,
      preferences(),
      pushNotifications() as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
    );

  const subscribed = async (steamId: string) => {
    await postgres.query(
      `INSERT INTO push_subscriptions (steam_id, endpoint, p256dh, auth)
            VALUES ($1::bigint, $2, 'key', 'auth')`,
      [steamId, `https://fcm.googleapis.com/fcm/send/${steamId}`],
    );
  };

  const activePlayer = async () => {
    const steamId = await fx.player();
    await postgres.query(
      `UPDATE players SET last_sign_in_at = now() WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return steamId;
  };

  describe("notification_preferences", () => {
    it("reports defaults for a player who has never chosen", async () => {
      const steamId = await fx.player();

      const rows = await preferences().list(steamId, "push");
      const chat = rows.find((row) => row.key === "chat");
      const infrastructure = rows.find(
        (row) => row.key === "staff_infrastructure",
      );

      expect(chat?.enabled).toBe(true);
      expect(infrastructure?.enabled).toBe(false);
    });

    it("stores and then clears an explicit choice", async () => {
      const steamId = await fx.player();
      const service = preferences();

      await service.set(steamId, "push", "chat", false);
      expect(
        (await service.list(steamId, "push")).find((row) => row.key === "chat")
          ?.enabled,
      ).toBe(false);

      // Absence of a row is what "use the default" means, so a reset has to
      // actually delete rather than write `true`.
      await service.reset(steamId, "push", "chat");
      const [remaining] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM notification_preferences
          WHERE steam_id = $1::bigint`,
        [steamId],
      );
      expect(remaining.count).toBe("0");
    });

    it("filters in-app recipients who muted the type", async () => {
      const muted = await fx.player();
      const listening = await fx.player();
      const service = preferences();

      await service.set(muted, "in_app", "ChatMessage", false);

      expect(
        await service.filterInAppRecipients("ChatMessage", [muted, listening]),
      ).toEqual([listening]);
    });

    it("leaves untoggleable types alone", async () => {
      const steamId = await fx.player();

      expect(
        await preferences().filterInAppRecipients("GameUpdate", [steamId]),
      ).toEqual([steamId]);
    });
  });

  describe("notifyActivePlayers", () => {
    it("writes one row per recently active player", async () => {
      const active = await activePlayer();
      const dormant = await fx.player();

      await notifications().notifyActivePlayers("NewsPublished", {
        title: "New article",
        message: "something happened",
        entity_id: "article-1",
      });

      const rows = await postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text AS steam_id FROM notifications WHERE type = 'NewsPublished'`,
      );

      expect(rows.map((row) => row.steam_id)).toEqual([active]);
      expect(rows.map((row) => row.steam_id)).not.toContain(dormant);
    });

    it("skips a player who muted the type in the bell", async () => {
      const active = await activePlayer();
      await preferences().set(active, "in_app", "NewsPublished", false);

      await notifications().notifyActivePlayers("NewsPublished", {
        title: "New article",
        message: "something happened",
        entity_id: "article-2",
      });

      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM notifications`,
      );
      expect(row.count).toBe("0");
    });

    // Push is delivered by the insert trigger on this table, so a muted bell
    // must not take the push with it -- push has its own preference.
    it("still writes a row for a muted player who can be pushed to", async () => {
      const active = await activePlayer();
      await preferences().set(active, "in_app", "NewsPublished", false);
      await subscribed(active);

      await notifications().notifyActivePlayers("NewsPublished", {
        title: "New article",
        message: "something happened",
        entity_id: "article-3",
      });

      const rows = await postgres.query<
        Array<{ steam_id: string; in_app: boolean }>
      >(
        `SELECT steam_id::text AS steam_id, in_app FROM notifications`,
      );

      expect(rows).toEqual([{ steam_id: active, in_app: false }]);
    });

    it("carries the image the writer hands over, and no data when there is none", async () => {
      const active = await activePlayer();

      await notifications().notifyActivePlayers("NewsPublished", {
        title: "New article",
        message: "something happened",
        entity_id: "article-4",
        data: { image: "/news/image/cover.png" },
      });
      await notifications().notifyActivePlayers("NewsPublished", {
        title: "Plain article",
        message: "nothing to show",
        entity_id: "article-5",
        data: { image: null },
      });

      const rows = await postgres.query<
        Array<{ entity_id: string; data: Record<string, unknown> | null }>
      >(
        `SELECT entity_id, data FROM notifications WHERE steam_id = $1::bigint
          ORDER BY entity_id`,
        [active],
      );

      expect(rows).toEqual([
        { entity_id: "article-4", data: { image: "/news/image/cover.png" } },
        { entity_id: "article-5", data: null },
      ]);
    });
  });

  describe("collapseOlderUnread", () => {
    it("keeps only the newest unread row for a conversation", async () => {
      const steamId = await fx.player();

      for (const body of ["first", "second", "third"]) {
        await postgres.query(
          `INSERT INTO notifications (type, title, message, role, steam_id, entity_id)
                VALUES ('ChatMessage', 'Someone', $1, 'user', $2::bigint, 'match:m-1')`,
          [body, steamId],
        );
      }

      await notifications().collapseOlderUnread("ChatMessage", "match:m-1", [
        steamId,
      ]);

      const rows = await postgres.query<Array<{ message: string }>>(
        `SELECT message FROM notifications
          WHERE deleted_at IS NULL AND type = 'ChatMessage'`,
      );

      expect(rows.map((row) => row.message)).toEqual(["third"]);
    });

    it("leaves another conversation untouched", async () => {
      const steamId = await fx.player();

      for (const entity of ["match:m-1", "match:m-2"]) {
        await postgres.query(
          `INSERT INTO notifications (type, title, message, role, steam_id, entity_id)
                VALUES ('ChatMessage', 'Someone', 'hi', 'user', $1::bigint, $2)`,
          [steamId, entity],
        );
      }

      await notifications().collapseOlderUnread("ChatMessage", "match:m-1", [
        steamId,
      ]);

      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM notifications WHERE deleted_at IS NULL`,
      );
      expect(row.count).toBe("2");
    });
  });

  // A notification that reaches the support webhook is posted verbatim into a
  // staff channel, so only the types an operator has to act on go there and
  // everything else is in-app. Routing used to say that the other way round --
  // a list of exclusions, with Discord the default -- which is how invites and
  // check-in reminders addressed to one player came to be posted to staff.
  //
  // The next type that gets routed through notifyPlayers, which is where the
  // webhook lives, should fail here rather than in a staff channel.
  describe("discord relay", () => {
    const withWebhook = () => {
      const hasura = hasuraWritingToPostgres();
      hasura.query = jest.fn().mockResolvedValue({
        settings_by_pk: { value: "https://discord.com/api/webhooks/1/token" },
      });

      return new NotificationsService(
        hasura as any,
        postgres,
        logger as any,
        { get: () => ({ webDomain: "https://example.com" }) } as any,
        preferences(),
        pushNotifications() as any,
        { add: jest.fn() } as any,
        { add: jest.fn() } as any,
      );
    };

    let posted: string[];

    beforeEach(() => {
      posted = [];
      jest
        .spyOn(global, "fetch")
        .mockImplementation(async (_url: any, init: any) => {
          posted.push(String(init?.body ?? ""));
          return { ok: true } as any;
        });
    });

    afterEach(() => {
      (global.fetch as jest.Mock).mockRestore?.();
    });

    const notify = async (type: string, message: string) => {
      const steamId = await fx.player();
      await withWebhook().notifyPlayers(type as any, {
        title: "Something",
        message,
        role: "user",
        entity_id: "e-1",
        steamIds: [steamId],
      });
    };

    it("never relays what somebody typed", async () => {
      // The body of a ChatMessage is the message itself, DMs included.
      await notify("ChatMessage", "meet me on B, bring flashes");

      expect(posted).toEqual([]);
    });

    it("never relays a player's own match report", async () => {
      await notify("MatchImported", "Your match was imported — you went 14/9.");

      expect(posted).toEqual([]);
    });

    it("keeps league scheduling out of the staff channel", async () => {
      await notify("LeagueProposalReceived", "A time was proposed.");

      expect(posted).toEqual([]);
    });

    // The complaint this came from: organizer invites were showing up in the
    // operators' channel. An invite is one player being asked something, and
    // staff have nothing to do about it either way.
    it("keeps an invite out of the staff channel", async () => {
      await notify("TournamentInvite", "You were invited to register.");

      expect(posted).toEqual([]);
    });

    it("keeps a check-in reminder out of the staff channel", async () => {
      await notify("TournamentCheckInOpen", "Check-in is open.");

      expect(posted).toEqual([]);
    });

    it("still relays the types that are meant for it", async () => {
      // Guards the test itself: if the webhook never fired for any type, every
      // assertion above would pass for the wrong reason.
      await notify("MatchSupport", "A match needs an admin.");

      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("A match needs an admin.");
    });
  });

  describe("push recipient resolution", () => {
    // What a bundling window has waiting in it, for the trailing-summary case.
    let pending: string[] = [];
    // Jobs the delivery queue was handed, so a deferred push can be told apart
    // from a dropped one.
    let pendingQueued: Array<{ delay?: number }> = [];

    // These are about the SQL, so redis is stubbed into its most permissive
    // shape: nobody has the thread focused, and every bundling window is free.
    const redisManager = {
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
          exec: async (): Promise<Array<unknown>> => [[null, pending]],
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
    };

    const service = () =>
      new PushNotificationsService(
        logger as any,
        postgres,
        {
          get: (key: string) =>
            key === "app"
              ? { webDomain: "https://example.com" }
              : {
                  publicKey: undefined as string | undefined,
                  privateKey: undefined as string | undefined,
                  subject: "x",
                },
        } as any,
        { add: async () => ({}) } as any,
        redisManager as any,
      );

    // The service above is deliberately left unconfigured, which makes every
    // send return before it reaches the database. This one has keys, so the
    // recipient SQL actually runs.
    const configuredService = async () => {
      const push = new PushNotificationsService(
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
        {
          add: async (_name: string, _data: unknown, options: any) => {
            pendingQueued.push(options ?? {});
            return {};
          },
        } as any,
        redisManager as any,
      );
      await push.loadKeys();
      return push;
    };

    const chatNotification = async (
      steamId: string,
      overrides: { createdAt?: string; isRead?: boolean } = {},
    ) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO notifications
                (type, title, message, role, steam_id, entity_id, is_read, data, created_at)
              VALUES ('ChatMessage', 'Luke', 'hey', 'user', $1::bigint,
                      'match:m-1', $2,
                      '{"threadKey":"chat:match:m-1"}'::jsonb,
                      COALESCE($3::timestamptz, now()))
           RETURNING id::text AS id`,
        [steamId, overrides.isRead ?? false, overrides.createdAt ?? null],
      );
      return row.id;
    };

    const subscribe = async (steamId: string) =>
      await postgres.query(
        `INSERT INTO push_subscriptions (steam_id, endpoint, p256dh, auth)
              VALUES ($1::bigint, $2, 'key', 'auth')`,
        [steamId, `https://fcm.googleapis.com/fcm/send/${steamId}`],
      );

    it("runs the recipient query without erroring", async () => {
      await expect(
        service().sendForNotification({ id: crypto.randomUUID(), type: "x" }),
      ).resolves.toBeUndefined();
    });

    it("resolves a subscribed recipient", async () => {
      const steamId = await fx.player();
      await subscribe(steamId);
      const id = await chatNotification(steamId);

      await (await configuredService()).sendForNotification({
        id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("says nothing when the thread was read after the message", async () => {
      // The whole point of the read cursor: a message the recipient has
      // already scrolled past is not worth a buzz.
      const steamId = await fx.player();
      await subscribe(steamId);
      const id = await chatNotification(steamId, {
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });

      await postgres.query(
        `INSERT INTO chat_read_state (steam_id, thread, last_read_at)
              VALUES ($1::bigint, 'chat:match:m-1', now())`,
        [steamId],
      );

      await (await configuredService()).sendForNotification({
        id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    it("still buzzes for a message newer than the cursor", async () => {
      const steamId = await fx.player();
      await subscribe(steamId);

      await postgres.query(
        `INSERT INTO chat_read_state (steam_id, thread, last_read_at)
              VALUES ($1::bigint, 'chat:match:m-1', now() - interval '1 hour')`,
        [steamId],
      );

      const id = await chatNotification(steamId);

      await (await configuredService()).sendForNotification({
        id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("ignores a cursor for a different thread", async () => {
      const steamId = await fx.player();
      await subscribe(steamId);
      const id = await chatNotification(steamId);

      await postgres.query(
        `INSERT INTO chat_read_state (steam_id, thread, last_read_at)
              VALUES ($1::bigint, 'chat:match:m-2', now())`,
        [steamId],
      );

      await (await configuredService()).sendForNotification({
        id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("badges what the bell would count, not just the player's own rows", async () => {
      // NotificationStore.unreadNotificationCount: own unread rows, the role
      // broadcasts the player can see, pending invites. An admin whose only
      // unread item is a role broadcast must not have the badge cleared by
      // the very push that announces it.
      const admin = await fx.player();
      await postgres.query(
        `UPDATE players SET role = 'administrator' WHERE steam_id = $1::bigint`,
        [admin],
      );
      await subscribe(admin);
      const team = await fx.team();
      await postgres.query(
        `INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
              VALUES ($1::uuid, $2::bigint, $3::bigint)`,
        [team.id, admin, team.owner],
      );
      await postgres.query(
        `INSERT INTO notifications (type, title, message, role, steam_id, entity_id)
              VALUES ('GameNodeStatus', 'Node', 'offline', 'match_organizer', NULL, 'n-1')`,
      );
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO notifications (type, title, message, role, steam_id, entity_id)
              VALUES ('PlayerSanctioned', 'Ban', 'x', 'administrator', NULL, 'p-1')
           RETURNING id::text AS id`,
      );

      await (await configuredService()).sendForNotification({
        id: row.id,
        type: "PlayerSanctioned",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(
        (webPush.sendNotification as jest.Mock).mock.calls[0][1],
      );
      // Two visible broadcasts plus one team invite.
      expect(payload.unread).toBe(3);
    });

    it("drops a row already dealt with in the bell", async () => {
      const steamId = await fx.player();
      await subscribe(steamId);
      const id = await chatNotification(steamId, { isRead: true });

      await (await configuredService()).sendForNotification({
        id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    it("keeps sending a type that does not require the row to be unseen", async () => {
      // An announcement's bell entry routinely sits unread for days, so a seen
      // check there would be measuring nothing.
      const steamId = await fx.player();
      await subscribe(steamId);

      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO notifications (type, title, message, role, steam_id, entity_id, is_read)
              VALUES ('NewsPublished', 'News', 'A post', 'user', $1::bigint, 'a-1', true)
           RETURNING id::text AS id`,
        [steamId],
      );

      await (await configuredService()).sendForNotification({
        id: row.id,
        type: "NewsPublished",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("holds back a read row for a type that does require it", async () => {
      // The same row, under a type whose policy asks for it, goes nowhere --
      // which is what makes the flag above load-bearing rather than decorative.
      const steamId = await fx.player();
      await subscribe(steamId);
      const id = await chatNotification(steamId, { isRead: true });

      await (await configuredService()).sendForNotification({
        id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    it("still counts a burst whose older rows the bell collapsed", async () => {
      // collapseOlderUnread soft-deletes every superseded ChatMessage row so
      // the bell shows one entry per conversation. The summary's count comes
      // from the window rather than from those rows for exactly that reason --
      // resolving them finds one survivor and would report a burst of three as
      // a single message.
      const steamId = await fx.player();
      await subscribe(steamId);

      const ids = [
        await chatNotification(steamId, {
          createdAt: new Date(Date.now() - 3000).toISOString(),
        }),
        await chatNotification(steamId, {
          createdAt: new Date(Date.now() - 2000).toISOString(),
        }),
        await chatNotification(steamId),
      ];

      await notifications().collapseOlderUnread("ChatMessage", "match:m-1", [
        steamId,
      ]);

      const [surviving] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM notifications
          WHERE type = 'ChatMessage' AND deleted_at IS NULL`,
      );
      expect(surviving.count).toBe("1");

      pending = ids;
      await (await configuredService()).sendPending(steamId, "chat:match:m-1");

      const [, payload] = (webPush.sendNotification as jest.Mock).mock.calls[0];
      expect(JSON.parse(payload)).toMatchObject({
        body: "3 new messages",
        count: 3,
      });
    });

    it("holds rather than drops during the recipient's quiet hours", async () => {
      const steamId = await fx.player();
      await subscribe(steamId);
      await postgres.query(
        `UPDATE players
            SET quiet_hours_start = (now() at time zone 'UTC' - interval '1 hour')::time,
                quiet_hours_end = (now() at time zone 'UTC' + interval '1 hour')::time,
                notification_timezone = 'UTC'
          WHERE steam_id = $1::bigint`,
        [steamId],
      );
      const id = await chatNotification(steamId);

      pendingQueued = [];
      await (await configuredService()).sendForNotification({
        id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();

      // Woken when the window closes rather than thrown away. The delay comes
      // from quiet_hours_seconds_remaining, which is what this really tests.
      const [job] = pendingQueued;
      expect(job).toBeDefined();
      expect(job.delay).toBeGreaterThan(0);
      // The window above ends an hour from now.
      expect(job.delay).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
    });

    it("stores a subscription and reassigns it on a shared browser", async () => {
      const first = await fx.player();
      const second = await fx.player();
      const push = service();
      const subscription = {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "key", auth: "auth" },
      };

      await push.subscribe(first, subscription, "a browser");
      await push.subscribe(second, subscription, "a browser");

      const rows = await postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text AS steam_id FROM push_subscriptions`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].steam_id).toBe(second);
    });

    it("only unsubscribes the caller's own endpoint", async () => {
      const owner = await fx.player();
      const other = await fx.player();
      const push = service();

      await push.subscribe(owner, {
        endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
        keys: { p256dh: "key", auth: "auth" },
      });

      await push.unsubscribe(other, "https://fcm.googleapis.com/fcm/send/xyz");

      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM push_subscriptions`,
      );
      expect(row.count).toBe("1");
    });
  });

  describe("quiet hours", () => {
    const isQuiet = async (start: string, end: string, tz = "UTC") => {
      const [row] = await postgres.query<Array<{ quiet: boolean }>>(
        `SELECT public.is_quiet_hours($1::time, $2::time, $3) AS quiet`,
        [start, end, tz],
      );
      return row.quiet;
    };

    // Anchored on the DB's own clock so the assertions hold whenever this runs.
    const nowLocal = async (tz = "UTC") => {
      const [row] = await postgres.query<Array<{ hhmm: string }>>(
        `SELECT to_char((now() AT TIME ZONE $1)::time, 'HH24:MI') AS hhmm`,
        [tz],
      );
      return row.hhmm;
    };

    const shiftHours = (hhmm: string, hours: number) => {
      const [h, m] = hhmm.split(":").map(Number);
      const shifted = (((h + hours) % 24) + 24) % 24;
      return `${String(shifted).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    };

    it("is off when unset", async () => {
      const [row] = await postgres.query<Array<{ quiet: boolean }>>(
        `SELECT public.is_quiet_hours(NULL, NULL, 'UTC') AS quiet`,
      );
      expect(row.quiet).toBe(false);
    });

    it("is off for a zero-width window", async () => {
      const now = await nowLocal();
      expect(await isQuiet(now, now)).toBe(false);
    });

    it("catches a window the current time sits inside", async () => {
      const now = await nowLocal();
      expect(await isQuiet(shiftHours(now, -1), shiftHours(now, 1))).toBe(true);
    });

    it("ignores a window the current time sits outside", async () => {
      const now = await nowLocal();
      expect(await isQuiet(shiftHours(now, 2), shiftHours(now, 4))).toBe(false);
    });

    describe("windows that wrap midnight", () => {
      // 22:00 -> 07:00 is the whole point of the feature, and it is the case a
      // naive `time BETWEEN start AND end` gets backwards.
      it("catches a time inside the wrapped window", async () => {
        const now = await nowLocal();
        expect(await isQuiet(shiftHours(now, -1), shiftHours(now, -3))).toBe(
          true,
        );
      });

      it("ignores a time outside the wrapped window", async () => {
        const now = await nowLocal();
        expect(await isQuiet(shiftHours(now, 1), shiftHours(now, -1))).toBe(
          false,
        );
      });
    });

    it("falls back to UTC rather than raising on an unknown timezone", async () => {
      // Raising here would abort the whole recipient query and silence push for
      // everyone, not just the player with the bad value.
      const now = await nowLocal("UTC");
      await expect(
        isQuiet(shiftHours(now, -1), shiftHours(now, 1), "Not/AZone"),
      ).resolves.toBe(true);
    });

    // Truncating the remainder to a whole second first turned the last fraction
    // of a second before the window closed into 0, which reads as "the end is
    // earlier in the day" -- and held the push, and everything after it in that
    // thread, for a full 24 hours.
    it("holds for seconds, not a day, when the window is about to close", async () => {
      const [row] = await postgres.query<Array<{ seconds: number }>>(
        `SELECT public.quiet_hours_seconds_remaining(
                  (now() AT TIME ZONE 'UTC')::time - interval '1 hour',
                  (now() AT TIME ZONE 'UTC')::time + interval '0.3 seconds',
                  'UTC'
                ) AS seconds`,
      );

      expect(row.seconds).toBeGreaterThan(0);
      expect(row.seconds).toBeLessThanOrEqual(2);
    });

    it("stores and reads back a window", async () => {
      const steamId = await fx.player();
      const service = preferences();

      await service.setQuietHours(steamId, {
        start: "22:00",
        end: "07:00",
        timezone: "America/New_York",
      });

      expect(await service.getQuietHours(steamId)).toEqual({
        start: "22:00",
        end: "07:00",
        timezone: "America/New_York",
      });
    });

    it("refuses a timezone Postgres does not know", async () => {
      const steamId = await fx.player();

      await expect(
        preferences().setQuietHours(steamId, {
          start: "22:00",
          end: "07:00",
          timezone: "Middle/Earth",
        }),
      ).rejects.toThrow();
    });

    it("refuses half a window", async () => {
      const steamId = await fx.player();

      await expect(
        preferences().setQuietHours(steamId, {
          start: "22:00",
          end: null,
          timezone: "UTC",
        }),
      ).rejects.toThrow();
    });
  });

  describe("resolveMatchAlerts", () => {
    const raiseAlert = async (matchId: string, steamId: string) =>
      postgres.query(
        `INSERT INTO notifications (type, title, message, role, steam_id, entity_id)
              VALUES ('MatchStatusChange', 'Match Alert: Map Paused', 'paused',
                      'user', $1::bigint, $2)`,
        [steamId, matchId],
      );

    const liveAlerts = async () => {
      const rows = await postgres.query<Array<{ entity_id: string }>>(
        `SELECT entity_id FROM notifications
          WHERE type = 'MatchStatusChange' AND deleted_at IS NULL`,
      );
      return rows.map((row) => row.entity_id);
    };

    it("retracts every outstanding alert for the match", async () => {
      // A month of pauses on one match is what produced 100+ rows nobody could
      // act on. Resuming should leave none of them behind.
      const steamId = await fx.player();
      for (let i = 0; i < 5; i++) {
        await raiseAlert("match-1", steamId);
      }

      await notifications().resolveMatchAlerts("match-1");

      expect(await liveAlerts()).toEqual([]);
    });

    it("leaves another match's alerts alone", async () => {
      const steamId = await fx.player();
      await raiseAlert("match-1", steamId);
      await raiseAlert("match-2", steamId);

      await notifications().resolveMatchAlerts("match-1");

      expect(await liveAlerts()).toEqual(["match-2"]);
    });

    it("does not touch other notification types for the same match", async () => {
      const steamId = await fx.player();
      await postgres.query(
        `INSERT INTO notifications (type, title, message, role, steam_id, entity_id)
              VALUES ('MatchSupport', 'Help', 'help', 'user', $1::bigint, 'match-1')`,
        [steamId],
      );
      await raiseAlert("match-1", steamId);

      await notifications().resolveMatchAlerts("match-1");

      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM notifications
          WHERE deleted_at IS NULL AND type = 'MatchSupport'`,
      );
      expect(row.count).toBe("1");
    });
  });

  describe("push_subscriptions endpoint constraint", () => {
    // The CHECK constraint and isAllowedPushEndpoint() enforce the same rule in
    // two languages. If they drift, either real browsers get rejected or the
    // SSRF the allowlist exists to stop walks straight past the database.
    const insertEndpoint = async (endpoint: string) => {
      const steamId = await fx.player();
      return postgres.query(
        `INSERT INTO push_subscriptions (steam_id, endpoint, p256dh, auth)
              VALUES ($1::bigint, $2, 'k', 'a')`,
        [steamId, endpoint],
      );
    };

    it.each([
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://android.googleapis.com/gcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc123",
      "https://web.push.apple.com/QRSTUV",
      "https://sin.notify.windows.com/w/?token=abc",
    ])("accepts %s", async (endpoint) => {
      await expect(insertEndpoint(endpoint)).resolves.toBeDefined();
      expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    });

    it.each([
      "http://10.0.0.5:8080/internal",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://hasura:8080/v1/graphql",
      "https://push.apple.com.attacker.test/x",
      "https://notfcm.googleapis.com/fcm/send/x",
      "http://fcm.googleapis.com/fcm/send/x",
    ])("rejects %s", async (endpoint) => {
      await expect(insertEndpoint(endpoint)).rejects.toThrow();
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    });
  });

  describe("TournamentReminders", () => {
    const createTournament = async (start: string) => {
      const organizer = await fx.player();
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
         SELECT 8, 1, 'Wingman', id, false, true, '{TestA}'
         FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      );
      const [tournament] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
              VALUES ($1, now() + $2::interval, $3, $4, 'RegistrationOpen') RETURNING id`,
        [fx.nextName("cup"), start, organizer, options.id],
      );
      return tournament.id;
    };

    const run = () =>
      new TournamentReminders(
        logger as any,
        postgres,
        notifications() as any,
      ).process();

    it("finds nothing for a tournament that is far out", async () => {
      await createTournament("5 days");

      expect(await run()).toBe(0);
    });

    it("fires only the day window at 20 hours out", async () => {
      // The floor on each window is what stops a tournament created shortly
      // before it starts firing both reminders in the same pass.
      const tournamentId = await createTournament("20 hours");
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
              VALUES ($1, 'A team', $2::bigint)`,
        [tournamentId, await fx.player()],
      );

      expect(await run()).toBe(1);

      const rows = await postgres.query<Array<{ entity_id: string }>>(
        `SELECT entity_id FROM notifications WHERE type = 'TournamentReminder'`,
      );
      expect(rows[0]?.entity_id).toBe(`${tournamentId}:1d`);
    });

    it("does not send the same window twice", async () => {
      const tournamentId = await createTournament("20 hours");
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
              VALUES ($1, 'A team', $2::bigint)`,
        [tournamentId, await fx.player()],
      );

      expect(await run()).toBe(1);
      expect(await run()).toBe(0);
    });
  });
});
