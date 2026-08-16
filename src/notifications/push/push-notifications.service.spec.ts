import * as webPush from "web-push";
import { PushNotificationsService } from "./push-notifications.service";
import { stripHtml } from "../utilities/stripHtml";
import { notificationUrl } from "../utilities/notificationUrl";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
  generateVAPIDKeys: jest.fn(),
}));

const notification = (overrides: Record<string, any> = {}) => ({
  id: "00000000-0000-0000-0000-0000000000ff",
  type: "MatchStatusChange",
  role: "user",
  title: "Match ready",
  message: 'Your match is <a href="https://example.com/matches/m-1">ready</a>',
  entity_id: "m-1",
  ...overrides,
});

// MULTI is used for two different pipelines -- draining a window's pending
// list, and resetting it -- so the stub has to chain every command either uses.
const chainableMulti = (result: unknown[]) => {
  const multi: Record<string, unknown> = {
    exec: jest.fn().mockResolvedValue(result),
  };

  for (const command of ["lrange", "del", "rpush", "expire"]) {
    multi[command] = jest.fn(() => multi);
  }

  return multi as any;
};

const subscription = (id: string) => ({
  id,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: "p256dh",
  auth: "auth",
});

describe("PushNotificationsService", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const postgres = { query: jest.fn() };
  const configService = {
    get: jest.fn<Record<string, string>, [string]>(),
  };
  // The focus each steam id reports, keyed by steam id. Empty means nobody is
  // looking at anything, which is the case every pre-existing test assumes.
  let focus: Record<string, string[]>;
  let pipelined: string[];
  const redis = {
    exists: jest.fn().mockResolvedValue(0),
    subscribe: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    // "OK" is the leading edge -- the window was free and this send claimed it.
    set: jest.fn().mockResolvedValue("OK"),
    get: jest.fn().mockResolvedValue(null),
    ttl: jest.fn().mockResolvedValue(-2),
    del: jest.fn().mockResolvedValue(1),
    rpush: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    multi: jest.fn(() => chainableMulti([[null, []]])),
    pipeline: jest.fn(() => ({
      set: jest.fn(),
      hvals: jest.fn((key: string) => {
        pipelined.push(key);
      }),
      exec: jest
        .fn()
        .mockImplementation(async () =>
          pipelined.map((key) => [
            null,
            focus[key.replace("presence:focus:", "")] ?? [],
          ]),
        ),
    })),
  };
  const redisManager = { getConnection: () => redis };
  const pushDeliveryQueue = { add: jest.fn().mockResolvedValue({}) };

  // Re-applied per test: clearAllMocks resets calls but not implementations, so
  // a test that swaps this out would otherwise leak into the next one.
  const withEnvKeys = () =>
    configService.get.mockImplementation((key) =>
      key === "app"
        ? { webDomain: "https://example.com" }
        : {
            publicKey: "public-key",
            privateKey: "private-key",
            subject: "https://example.com",
          },
    );

  let service: PushNotificationsService;
  let notificationRow: Record<string, any> | undefined;
  let settings: Record<string, string>;
  let subscriptions: Array<ReturnType<typeof subscription>>;
  let recipients: string[];
  // Seconds of quiet window left for every recipient; 0 means nobody is asleep.
  let quietSeconds: number;
  let bundled: Array<Record<string, any>>;
  let updates: Array<{ sql: string; bindings: any[] }>;

  // Keys are resolved from settings (with env taking precedence), so they are
  // not known until loadKeys() runs.
  const build = async () => {
    const service = new PushNotificationsService(
      logger as any,
      postgres as any,
      configService as any,
      pushDeliveryQueue as any,
      redisManager as any,
    );
    await service.loadKeys();
    return service;
  };

  // The recipient query returns one row per (notification, device). Tests
  // describe the notification and its devices; this is the join between them.
  const deliveryRows = () =>
    (recipients.length > 0 ? recipients : ["76561100000000001"]).flatMap(
      (steam_id) =>
        subscriptions.map((sub) => ({
          ...notificationRow,
          steam_id,
          quiet_seconds: quietSeconds,
          subscription_id: sub.id,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
        })),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    withEnvKeys();
    notificationRow = notification();
    subscriptions = [subscription("sub-1")];
    recipients = [];
    quietSeconds = 0;
    bundled = [];
    focus = {};
    pipelined = [];
    updates = [];
    settings = {};

    postgres.query.mockImplementation(async (sql: string, bindings: any[]) => {
      if (sql.includes("FROM public.notifications\n")) {
        return notificationRow ? [notificationRow] : [];
      }
      if (sql.includes("push_subscriptions ps")) {
        return bundled.length > 0 ? bundled : deliveryRows();
      }
      if (sql.includes("INSERT INTO public.settings")) {
        updates.push({ sql, bindings });

        for (let i = 0; i < bindings.length; i += 2) {
          // DO NOTHING is the bootstrap write: whoever got there first keeps it.
          if (
            sql.includes("DO NOTHING") &&
            settings[bindings[i]] !== undefined
          ) {
            continue;
          }

          settings[bindings[i]] = bindings[i + 1];
        }

        return [];
      }
      if (sql.includes("FROM public.settings")) {
        const wanted = Array.isArray(bindings[0]) ? bindings[0] : [bindings[0]];

        return wanted
          .filter((name: string) => settings[name] !== undefined)
          .map((name: string) => ({ name, value: settings[name] }));
      }
      updates.push({ sql, bindings });
      return [];
    });

    (webPush.sendNotification as jest.Mock).mockResolvedValue({});
    service = await build();
  });

  it("sends to a targeted player's devices", async () => {
    subscriptions = [subscription("sub-1"), subscription("sub-2")];

    await service.sendForNotification({
      id: notificationRow.id,
      type: "MatchStatusChange",
    });

    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
  });

  describe("role broadcasts", () => {
    const rolesQueriedFor = () =>
      postgres.query.mock.calls.find(([sql]: [string]) =>
        sql.includes("push_subscriptions ps"),
      )?.[1][1];

    it("reaches nobody for a user-role broadcast", async () => {
      // Our notifications select_permissions never let `user` see a
      // role-targeted row, so pushing one would notify people about something
      // they cannot open.
      notificationRow = notification({ role: "user" });

      await service.sendForNotification({
        id: notificationRow.id,
        type: "MatchStatusChange",
      });

      expect(rolesQueriedFor()).toEqual([]);
    });

    it("mirrors the bell's per-role enumeration rather than a hierarchy", async () => {
      notificationRow = notification({ role: "match_organizer" });

      await service.sendForNotification({
        id: notificationRow.id,
        type: "MatchStatusChange",
      });

      // Excludes administrator, matching public_notifications.yaml. Widening
      // this without also widening the *update* permission is what left admins
      // staring at 100+ broadcasts they could not dismiss.
      expect(rolesQueriedFor()).toEqual([
        "match_organizer",
        "tournament_organizer",
      ]);
    });

    it("does not widen an administrator broadcast", async () => {
      notificationRow = notification({ role: "administrator" });

      await service.sendForNotification({
        id: notificationRow.id,
        type: "GameUpdate",
      });

      expect(rolesQueriedFor()).toEqual(["administrator"]);
    });
  });

  describe("delivery bookkeeping", () => {
    it("removes subscriptions the push service reports as gone", async () => {
      subscriptions = [subscription("gone"), subscription("alive")];
      (webPush.sendNotification as jest.Mock).mockImplementation(
        async (target: { endpoint: string }) => {
          if (target.endpoint.endsWith("gone")) {
            throw { statusCode: 410 };
          }
          return {};
        },
      );

      await service.sendForNotification({
        id: notificationRow.id,
        type: "MatchStatusChange",
      });

      const deleted = updates.find(({ sql }) => sql.includes("DELETE"));
      expect(deleted?.bindings[0]).toEqual(["gone"]);

      const touched = updates.find(({ sql }) => sql.includes("last_used_at"));
      expect(touched?.bindings[0]).toEqual(["alive"]);
    });

    it("keeps subscriptions after a transient failure", async () => {
      subscriptions = [subscription("flaky")];
      (webPush.sendNotification as jest.Mock).mockRejectedValue({
        statusCode: 500,
      });

      await service.sendForNotification({
        id: notificationRow.id,
        type: "MatchStatusChange",
      });

      expect(updates.find(({ sql }) => sql.includes("DELETE"))).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("does nothing when the notification row is gone", async () => {
      notificationRow = undefined;

      await service.sendForNotification({ id: "missing", type: "GameUpdate" });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe("key resolution", () => {
    const withoutEnvKeys = () =>
      configService.get.mockImplementation((key: string) =>
        key === "app"
          ? { webDomain: "https://example.com" }
          : { subject: "https://example.com" },
      );

    it("generates a keypair when nothing is configured", async () => {
      // The panel writes keys into api-secrets on install, but an older install
      // -- or one deployed without it -- must not sit permanently disabled.
      withoutEnvKeys();
      (webPush.generateVAPIDKeys as jest.Mock).mockReturnValue({
        publicKey: "generated-public",
        privateKey: "generated-private",
      });

      const service = await build();

      expect(service.isConfigured()).toBe(true);
      expect(service.getPublicKey()).toBe("generated-public");
      expect(
        updates.some(
          ({ sql, bindings }) =>
            sql.includes("INSERT INTO public.settings") &&
            bindings.includes("web_push_private_key") &&
            bindings.includes("generated-private"),
        ),
      ).toBe(true);
    });

    // Two pods booting into an install with no keys both generate one. If the
    // second overwrote the first, they would sign with different private keys
    // and every subscription taken out against the loser's public key would be
    // rejected 403 until that pod restarted.
    it("adopts the keypair another pod stored first", async () => {
      withoutEnvKeys();
      (webPush.generateVAPIDKeys as jest.Mock).mockReturnValue({
        publicKey: "first-public",
        privateKey: "first-private",
      });

      const first = await build();

      (webPush.generateVAPIDKeys as jest.Mock).mockReturnValue({
        publicKey: "second-public",
        privateKey: "second-private",
      });

      const second = await build();

      expect(first.getPublicKey()).toBe("first-public");
      expect(second.getPublicKey()).toBe("first-public");
      expect(webPush.setVapidDetails).toHaveBeenLastCalledWith(
        "https://example.com",
        "first-public",
        "first-private",
      );
    });

    it("stays inert when a keypair cannot be produced", async () => {
      withoutEnvKeys();
      (webPush.generateVAPIDKeys as jest.Mock).mockImplementation(() => {
        throw new Error("no crypto");
      });

      const service = await build();

      expect(service.isConfigured()).toBe(false);
      expect(service.getPublicKey()).toBeNull();

      await service.sendForNotification({ id: "x", type: "GameUpdate" });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    it("prefers environment keys over stored ones", async () => {
      const service = await build();

      expect(service.isManagedByEnvironment()).toBe(true);
      expect(service.getPublicKey()).toBe("public-key");
      expect(webPush.generateVAPIDKeys).not.toHaveBeenCalled();
    });
  });

  describe("focus gating", () => {
    const chat = () =>
      notification({
        type: "ChatMessage",
        title: "Luke",
        message: "hey",
        entity_id: "match:m-1",
        data: { threadKey: "chat:match:m-1", threadLabel: "Ancients vs Ratz" },
      });

    it("says nothing to a player already reading the conversation", async () => {
      notificationRow = chat();
      recipients = ["76561100000000001"];
      focus["76561100000000001"] = ["chat:match:m-1"];

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    it("still buzzes a player looking at a different conversation", async () => {
      notificationRow = chat();
      recipients = ["76561100000000001"];
      focus["76561100000000001"] = ["chat:direct:1:2"];

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("gates each recipient of a fan-out on their own attention", async () => {
      // One row per lobby member, so the reader and the absentee arrive
      // together and only one of them should hear about it.
      notificationRow = chat();
      recipients = ["76561100000000001", "76561100000000002"];
      focus["76561100000000001"] = ["chat:match:m-1"];

      await service.sendForIds([notificationRow.id]);

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe("bundling", () => {
    const chat = (overrides: Record<string, any> = {}) =>
      notification({
        type: "ChatMessage",
        title: "Luke",
        message: "hey",
        entity_id: "match:m-1",
        data: { threadKey: "chat:match:m-1", threadLabel: "Ancients vs Ratz" },
        ...overrides,
      });

    const payloadOf = (call: number) =>
      JSON.parse((webPush.sendNotification as jest.Mock).mock.calls[call][1]);

    it("pushes the first message of a burst straight away", async () => {
      notificationRow = chat();
      recipients = ["76561100000000001"];

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
      expect(payloadOf(0)).toMatchObject({
        title: "Luke",
        body: "hey",
        tag: "chat:match:m-1",
        renotify: true,
        threadKey: "chat:match:m-1",
      });
    });

    it("holds a message that lands inside an open window", async () => {
      notificationRow = chat();
      recipients = ["76561100000000001"];
      // The window is already taken, which is what a second message sees.
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValueOnce("token-1");
      redis.ttl.mockResolvedValueOnce(12);

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
      expect(pushDeliveryQueue.add).toHaveBeenCalledWith(
        "PushDelivery",
        { steamId: "76561100000000001", thread: "chat:match:m-1" },
        expect.objectContaining({
          jobId: "push-trail.76561100000000001.chat:match:m-1.token-1",
          delay: 12000,
          // A completed job holding a static id would stop the next window
          // with the same token from ever being scheduled.
          removeOnComplete: true,
        }),
      );
    });

    it("counts the message that opened the window", async () => {
      // The summary replaces the leading notification on the device, so
      // leaving it out of the tally makes a burst of four report three.
      notificationRow = chat();
      recipients = ["76561100000000001"];

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      const reset = redis.multi.mock.results.at(-1)?.value;

      expect(reset.del).toHaveBeenCalledWith(
        "notifications:push-pending:76561100000000001:chat:match:m-1",
      );
      expect(reset.rpush).toHaveBeenCalledWith(
        "notifications:push-pending:76561100000000001:chat:match:m-1",
        notificationRow.id,
      );
    });

    it("takes the leading edge when the window expired mid-decision", async () => {
      notificationRow = chat();
      recipients = ["76561100000000001"];
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValueOnce(null);
      redis.ttl.mockResolvedValueOnce(-2);

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
      expect(pushDeliveryQueue.add).not.toHaveBeenCalled();
    });

    it("replaces the burst with one summary when the window closes", async () => {
      const held = ["id-a", "id-b", "id-c"];
      redis.multi.mockReturnValueOnce(chainableMulti([[null, held]]));

      notificationRow = chat();
      bundled = held.map((id) => ({
        ...chat({ id }),
        steam_id: "76561100000000001",
        subscription_id: "sub-1",
        endpoint: subscription("sub-1").endpoint,
        p256dh: "p256dh",
        auth: "auth",
      }));

      await service.sendPending("76561100000000001", "chat:match:m-1");

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
      expect(payloadOf(0)).toMatchObject({
        title: "Luke",
        body: "3 new messages",
        tag: "chat:match:m-1",
        renotify: true,
        threadKey: "chat:match:m-1",
      });
    });

    it("names the room when a burst has more than one sender", async () => {
      const held = ["id-a", "id-b", "id-c"];
      redis.multi.mockReturnValueOnce(chainableMulti([[null, held]]));

      notificationRow = chat();
      bundled = ["Luke", "Ratz", "Catz"].map((title, index) => ({
        ...chat({ id: held[index], title }),
        steam_id: "76561100000000001",
        subscription_id: "sub-1",
        endpoint: subscription("sub-1").endpoint,
        p256dh: "p256dh",
        auth: "auth",
      }));

      await service.sendPending("76561100000000001", "chat:match:m-1");

      expect(payloadOf(0)).toMatchObject({
        title: "Ancients vs Ratz",
        body: "3 new messages from Luke, Ratz and 1 others",
      });
    });

    it("holds a message until quiet hours are over", async () => {
      // Dropped outright before, so a night of messages arrived as nothing at
      // all -- a silent phone and a full bell in the morning.
      notificationRow = chat();
      recipients = ["76561100000000001"];
      quietSeconds = 6 * 60 * 60;

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
      expect(pushDeliveryQueue.add).toHaveBeenCalledWith(
        "PushDelivery",
        { steamId: "76561100000000001", thread: "chat:match:m-1" },
        // Woken when the window closes, not on the bundling window.
        expect.objectContaining({ delay: 6 * 60 * 60 * 1000 }),
      );
    });

    it("defers even a type that never bundles", async () => {
      notificationRow = notification({ type: "TeamInvite", entity_id: "t-1" });
      recipients = ["76561100000000001"];
      quietSeconds = 3600;

      await service.sendForNotification({
        id: notificationRow.id,
        type: "TeamInvite",
      });

      expect(webPush.sendNotification).not.toHaveBeenCalled();
      expect(pushDeliveryQueue.add).toHaveBeenCalled();
    });

    it("keeps the held payload alive past the whole quiet window", async () => {
      // The pending list used to expire after fifteen minutes, which would
      // have thrown the night away long before anyone woke up.
      notificationRow = chat();
      recipients = ["76561100000000001"];
      quietSeconds = 8 * 60 * 60;

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      const reset = redis.multi.mock.results.at(-1)?.value;

      expect(reset.expire).toHaveBeenCalledWith(
        "notifications:push-pending:76561100000000001:chat:match:m-1",
        8 * 60 * 60 + 300,
      );
    });

    it("releases the window even when nothing survives the gate", async () => {
      // Otherwise the next burst's leading push is swallowed too, and goes on
      // being swallowed until the key expires on its own.
      await service.sendPending("76561100000000001", "chat:match:m-1");

      expect(redis.del).toHaveBeenCalledWith(
        "notifications:push-window:76561100000000001:chat:match:m-1",
      );
      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    it("says nothing if the player opened the thread while it was held", async () => {
      const held = ["id-a", "id-b"];
      redis.multi.mockReturnValueOnce(chainableMulti([[null, held]]));

      notificationRow = chat();
      bundled = held.map((id) => ({
        ...chat({ id }),
        steam_id: "76561100000000001",
        subscription_id: "sub-1",
        endpoint: subscription("sub-1").endpoint,
        p256dh: "p256dh",
        auth: "auth",
      }));
      focus["76561100000000001"] = ["chat:match:m-1"];

      await service.sendPending("76561100000000001", "chat:match:m-1");

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });
  });

  it("batches the fan-out types", () => {
    expect(PushNotificationsService.isBatched("NewsPublished")).toBe(true);
    expect(PushNotificationsService.isBatched("TournamentCreated")).toBe(true);
    expect(PushNotificationsService.isBatched("MatchStatusChange")).toBe(false);
  });
});

describe("stripHtml", () => {
  it("renders markup as the plain text the bell shows", () => {
    expect(stripHtml("<a href='/x'><b>Cool Team</b></a> won")).toBe(
      "Cool Team won",
    );
  });

  it("decodes the entities escapeHtml wrote", () => {
    // A tag-stripping regex leaves "&amp;" here, which is the whole reason
    // this goes through a real HTML parser.
    expect(stripHtml("<b>Ratz &amp; Catz</b> won")).toBe("Ratz & Catz won");
  });

  it("truncates rather than filling a lock screen", () => {
    const long = stripHtml(`<p>${"a".repeat(500)}</p>`);

    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("survives an empty message", () => {
    expect(stripHtml(null)).toBe("");
  });
});

describe("notificationUrl", () => {
  const webDomain = "https://example.com";

  it("reuses the link the message already carries", () => {
    expect(
      notificationUrl(
        {
          type: "NewsPublished",
          message: '<a href="https://example.com/news/a-slug">Title</a>',
          entity_id: "article-1",
        },
        webDomain,
      ),
    ).toBe("/news/a-slug");
  });

  it("falls back to a route when the message has no link", () => {
    expect(
      notificationUrl(
        { type: "MatchStatusChange", message: "Live now", entity_id: "m-1" },
        webDomain,
      ),
    ).toBe("/matches/m-1");
  });

  it("strips the reminder window off a tournament entity id", () => {
    expect(
      notificationUrl(
        { type: "TournamentReminder", message: "Soon", entity_id: "t-1:2h" },
        webDomain,
      ),
    ).toBe("/tournaments/t-1");
  });

  it("ignores an off-site link", () => {
    expect(
      notificationUrl(
        {
          type: "GameUpdate",
          message: '<a href="https://evil.example/x">click</a>',
          entity_id: "g-1",
        },
        webDomain,
      ),
    ).toBe("/");
  });
});
