import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { TournamentReminders } from "./../src/matches/jobs/TournamentReminders";
import { NotificationsService } from "./../src/notifications/notifications.service";
import { NotificationPreferencesService } from "./../src/notifications/preferences/notification-preferences.service";
import { PushNotificationsService } from "./../src/notifications/push/push-notifications.service";
import { isAllowedPushEndpoint } from "./../src/notifications/push/push-endpoint";

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
          `INSERT INTO notifications (type, title, message, role, steam_id, entity_id)
                VALUES ($1, $2, $3, $4, $5::bigint, $6)`,
          [
            object.type,
            object.title,
            object.message,
            object.role,
            object.steam_id,
            object.entity_id ?? null,
          ],
        );
      }

      return { insert_notifications: { affected_rows: insert.length } };
    }),
  });

  const notifications = () =>
    new NotificationsService(
      hasuraWritingToPostgres() as any,
      postgres,
      logger as any,
      { get: () => ({ webDomain: "https://example.com" }) } as any,
      preferences(),
      { add: jest.fn() } as any,
    );

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

  describe("push recipient resolution", () => {
    const service = () =>
      new PushNotificationsService(logger as any, postgres, {
        get: (key: string) =>
          key === "app"
            ? { webDomain: "https://example.com" }
            : { publicKey: undefined, privateKey: undefined, subject: "x" },
      } as any);

    it("runs the recipient query without erroring", async () => {
      // VAPID is unconfigured here so nothing is actually sent -- this is
      // about the SQL parsing and casting cleanly.
      await expect(
        service().sendForNotification({ id: crypto.randomUUID(), type: "x" }),
      ).resolves.toBeUndefined();
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
