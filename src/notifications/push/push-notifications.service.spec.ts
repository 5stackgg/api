import * as webPush from "web-push";
import {
  PushAction,
  PushNotificationsService,
} from "./push-notifications.service";
// Asserted against rather than a string, because the generic queue processor
// resolves the handler by exactly this name.
import { SendPushDelivery } from "../jobs/SendPushDelivery";
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
        ? {
            webDomain: "https://example.com",
            apiDomain: "https://api.example.com",
          }
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
  // What the badge-count query answers with.
  let unread: number;

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
    unread = 4;

    postgres.query.mockImplementation(async (sql: string, bindings: any[]) => {
      if (sql.includes("count(*)::text AS unread")) {
        return [{ unread: String(unread) }];
      }
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

    it("reaches everyone senior enough to act on a broadcast", async () => {
      notificationRow = notification({ role: "match_organizer" });

      await service.sendForNotification({
        id: notificationRow.id,
        type: "MatchStatusChange",
      });

      // Administrators included, matching public_notifications.yaml -- both
      // permissions in it. Widening select alone is what left admins staring
      // at 100+ broadcasts they could not dismiss.
      expect(rolesQueriedFor()).toEqual([
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ]);
    });

    it("keeps a tournament_organizer broadcast off match organizers", async () => {
      notificationRow = notification({ role: "tournament_organizer" });

      await service.sendForNotification({
        id: notificationRow.id,
        type: "MatchStatusChange",
      });

      expect(rolesQueriedFor()).toEqual([
        "tournament_organizer",
        "administrator",
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
          ? {
              webDomain: "https://example.com",
              apiDomain: "https://api.example.com",
            }
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
      // Named room and all: a message on its own still has to say where it
      // came from, which only the bundled summary used to do.
      expect(payloadOf(0)).toMatchObject({
        title: "Luke · Ancients vs Ratz",
        body: "hey",
        tag: "chat:match:m-1",
        renotify: true,
        threadKey: "chat:match:m-1",
      });
    });

    it("does not repeat a direct message's sender as its room", async () => {
      // A DM's label is whoever sent it, so naming the room would say the
      // same name twice.
      notificationRow = chat({
        entity_id: "direct:1:2",
        data: { threadKey: "chat:direct:1:2", threadLabel: "Luke" },
      });
      recipients = ["76561100000000001"];

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(payloadOf(0)).toMatchObject({ title: "Luke" });
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
        SendPushDelivery.name,
        { steamId: "76561100000000001", thread: "chat:match:m-1" },
        expect.objectContaining({
          // Colons encoded: BullMQ rejects a custom job id containing one.
          jobId: "push-trail.76561100000000001.chat%3Amatch%3Am-1.token-1",
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

    it("claims the window it reports taking after a double miss", async () => {
      // Both attempts lost the race and both then found the key already gone.
      // Reporting a leading edge without holding the key opens a bundle that
      // nothing will ever drain, and the next message takes the edge as well.
      notificationRow = chat();
      recipients = ["76561100000000001"];
      redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      redis.get.mockResolvedValue(null);
      redis.ttl.mockResolvedValue(-2);

      await service.sendForNotification({
        id: notificationRow.id,
        type: "ChatMessage",
      });

      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
      // Plain SET, not SET NX: the two NX attempts above are what just failed.
      expect(redis.set).toHaveBeenLastCalledWith(
        "notifications:push-window:76561100000000001:chat:match:m-1",
        expect.any(String),
        "EX",
        expect.any(Number),
      );
    });

    it("holds again when quiet hours began while the window was open", async () => {
      // A bundling window opened seconds before 22:00 closes inside quiet
      // hours, and delivering its summary there is the buzz the hold exists to
      // prevent.
      const held = ["id-a", "id-b"];
      redis.multi.mockReturnValueOnce(chainableMulti([[null, held]]));

      notificationRow = chat();
      bundled = held.map((id) => ({
        ...chat({ id }),
        steam_id: "76561100000000001",
        quiet_seconds: 6 * 60 * 60,
        subscription_id: "sub-1",
        endpoint: subscription("sub-1").endpoint,
        p256dh: "p256dh",
        auth: "auth",
      }));

      await service.sendPending("76561100000000001", "chat:match:m-1");

      expect(webPush.sendNotification).not.toHaveBeenCalled();
      expect(pushDeliveryQueue.add).toHaveBeenCalledWith(
        SendPushDelivery.name,
        { steamId: "76561100000000001", thread: "chat:match:m-1" },
        expect.objectContaining({ delay: 6 * 60 * 60 * 1000 }),
      );
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
        title: "Luke · Ancients vs Ratz",
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
        SendPushDelivery.name,
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

  describe("rich payload", () => {
    const payloadOf = (call: number) =>
      JSON.parse((webPush.sendNotification as jest.Mock).mock.calls[call][1]);

    const send = async () => {
      await service.sendForNotification({
        id: notificationRow.id,
        type: notificationRow.type,
      });
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
      return payloadOf(0);
    };

    it("qualifies API-served images and leaves full URLs alone", async () => {
      // Stored avatar paths have no leading slash (avatars.service buildPath);
      // writers that hand over a path of their own may well add one.
      notificationRow = notification({
        data: {
          icon: "https://avatars.steamstatic.com/abc_full.jpg",
          image: "avatars/awards/gold.png",
        },
      });

      expect(await send()).toMatchObject({
        icon: "https://avatars.steamstatic.com/abc_full.jpg",
        image: "https://api.example.com/avatars/awards/gold.png",
      });

      (webPush.sendNotification as jest.Mock).mockClear();
      notificationRow = notification({ data: { image: "/news/image/a.png" } });

      expect(await send()).toMatchObject({
        image: "https://api.example.com/news/image/a.png",
      });
    });

    it("drops an image that is neither", async () => {
      // `//evil.test/x` is a fully qualified URL, and the browser would fetch
      // it as one.
      notificationRow = notification({ data: { image: "//evil.test/x.png" } });

      expect(await send()).not.toHaveProperty("image");
    });

    it("tells the device how many the bell has waiting", async () => {
      unread = 7;

      expect(await send()).toMatchObject({
        unread: 7,
        graphqlUrl: "https://api.example.com/v1/graphql",
      });
    });

    it("still sends when the count cannot be taken", async () => {
      const base = postgres.query.getMockImplementation();
      postgres.query.mockImplementation(async (sql: string, bindings: any[]) =>
        sql.includes("count(*)::text AS unread")
          ? Promise.reject(new Error("db away"))
          : base(sql, bindings),
      );

      const payload = await send();

      expect(payload).not.toHaveProperty("unread");
      expect(payload.title).toBe("Match ready");
    });

    it("offers Dismiss on a plain notification", async () => {
      const payload = await send();

      expect(payload.actions).toHaveLength(1);
      expect(payload.actions[0]).toMatchObject({
        action: "dismiss",
        title: "Dismiss",
      });
      expect(payload.actions[0].operation.query).toContain(
        "update_notifications(where:$v1,_set:$v2){affected_rows}",
      );
      expect(payload.actions[0].operation.variables).toEqual({
        v1: { id: { _in: [notificationRow.id] } },
        v2: { is_read: true },
      });
    });

    it("turns the bell's buttons into notification buttons", async () => {
      notificationRow = notification({
        type: "ScrimRequestReceived",
        entity_id: "req-1",
        actions: [
          {
            label: "Accept",
            graphql: {
              type: "mutation",
              action: "respondToScrimRequest",
              selection: { success: true },
              variables: { request_id: "req-1", accept: true },
            },
          },
          {
            label: "Decline",
            graphql: {
              type: "mutation",
              action: "respondToScrimRequest",
              selection: { success: true },
              variables: { request_id: "req-1", accept: false },
            },
          },
        ],
      });

      const { actions } = await send();

      expect(actions.map(({ title }: PushAction) => title)).toEqual([
        "Accept",
        "Decline",
      ]);
      // The button runs the mutation, then reads the row -- the bell does the
      // same two things when one of its buttons is pressed.
      expect(actions[0].operation.query).toMatch(
        /respondToScrimRequest\(request_id:\$v1,accept:\$v2\)\{success\},update_notifications\(/,
      );
      expect(actions[0].operation.variables).toMatchObject({
        v1: "req-1",
        v2: true,
      });
      expect(actions[1].operation.variables).toMatchObject({ v2: false });
    });

    it("lets a team invite be answered from the notification", async () => {
      notificationRow = notification({
        type: "TeamInvite",
        entity_id: "11111111-1111-1111-1111-111111111111",
        message: "Ancients invited you",
      });

      const { actions } = await send();

      expect(actions.map(({ action }: PushAction) => action)).toEqual([
        "accept",
        "decline",
      ]);
      expect(actions[0].operation.query).toContain("acceptInvite(");
      expect(actions[1].operation.query).toContain("denyInvite(");
      expect(actions[0].operation.variables).toMatchObject({
        v1: "team",
        v2: "11111111-1111-1111-1111-111111111111",
      });
    });

    it("lets a draft invite be answered from the notification", async () => {
      notificationRow = notification({
        type: "DraftInvite",
        entity_id: "22222222-2222-2222-2222-222222222222",
        message: "Luke invited you to a draft",
      });

      const { actions } = await send();

      expect(actions[0].operation.query).toContain("respondDraftInvite(");
      expect(actions[0].operation.variables).toMatchObject({
        v1: "22222222-2222-2222-2222-222222222222",
        v2: true,
      });
      expect(actions[1].operation.variables).toMatchObject({ v2: false });
    });

    it("gives chat no buttons", async () => {
      // Reading the bell row would leave the conversation's own cursor where
      // it was, so a Dismiss here would lie.
      notificationRow = notification({
        type: "ChatMessage",
        title: "Luke",
        message: "hey",
        entity_id: "match:m-1",
        data: { threadKey: "chat:match:m-1", threadLabel: "Ancients vs Ratz" },
      });
      recipients = ["76561100000000001"];

      expect((await send()).actions).toEqual([]);
    });

    it("keeps a broken stored action from blocking the push", async () => {
      notificationRow = notification({
        actions: [
          {
            label: "Boom",
            graphql: {
              type: "mutation",
              action: "noSuchMutation",
              selection: { success: true },
              variables: { x: 1 },
            },
          },
        ],
      });

      const payload = await send();

      expect(payload.title).toBe("Match ready");
      expect(payload.actions).toEqual([]);
    });
  });

  it("batches the fan-out types", () => {
    expect(PushNotificationsService.isBatched("NewsPublished")).toBe(true);
    expect(PushNotificationsService.isBatched("TournamentCreated")).toBe(true);
    // A notifyPlayers fan-out rather than a notifyActivePlayers one, and the
    // largest of them: every co-player from six months of matches.
    expect(PushNotificationsService.isBatched("PlayerSanctioned")).toBe(true);
    expect(PushNotificationsService.isBatched("MatchStatusChange")).toBe(false);
  });
});

describe("batchJobId", () => {
  const minutes = (n: number) => n * 60_000;

  it("collapses one burst onto a single id", () => {
    const at = Date.parse("2026-08-18T10:00:00.000Z");

    // Every row of a fan-out lands within seconds of the others.
    expect(
      PushNotificationsService.batchJobId("PlayerSanctioned", "7656119", at),
    ).toBe(
      PushNotificationsService.batchJobId(
        "PlayerSanctioned",
        "7656119",
        at + 4_000,
      ),
    );
  });

  it("lets the same entity through again in a later window", () => {
    // The bug this exists for: a player muted at 10:00 and banned at 10:20 got
    // one id, and BullMQ dropped the ban as a duplicate of the completed job it
    // keeps for an hour. Nobody was told about the ban.
    const muted = Date.parse("2026-08-18T10:00:00.000Z");

    expect(
      PushNotificationsService.batchJobId("PlayerSanctioned", "7656119", muted),
    ).not.toBe(
      PushNotificationsService.batchJobId(
        "PlayerSanctioned",
        "7656119",
        muted + minutes(20),
      ),
    );
  });

  it("never collapses two entities onto one id", () => {
    const at = Date.parse("2026-08-18T10:00:00.000Z");

    expect(
      PushNotificationsService.batchJobId("PlayerSanctioned", "7656119", at),
    ).not.toBe(
      PushNotificationsService.batchJobId("PlayerSanctioned", "7656120", at),
    );
  });

  it("keeps the bucket no wider than the window a batch resolves over", () => {
    // A bucket wider than the lookback would swallow a burst that the send it
    // collapsed onto can no longer see.
    const at = Date.parse("2026-08-18T10:00:00.000Z");
    const window = PushNotificationsService.BATCH_WINDOW_MINUTES;

    expect(
      PushNotificationsService.batchJobId("NewsPublished", "n-1", at),
    ).not.toBe(
      PushNotificationsService.batchJobId(
        "NewsPublished",
        "n-1",
        at + minutes(window),
      ),
    );
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
    // StorageScan has no route of its own, so nothing but the rejected href
    // could produce anything other than "/".
    expect(
      notificationUrl(
        {
          type: "StorageScan",
          message: '<a href="https://evil.example/x">click</a>',
          entity_id: "s-1",
        },
        webDomain,
      ),
    ).toBe("/");
  });

  it("falls back to the type's route rather than an off-site link", () => {
    expect(
      notificationUrl(
        {
          type: "GameUpdate",
          message: '<a href="https://evil.example/x">click</a>',
          entity_id: "g-1",
        },
        webDomain,
      ),
    ).toBe("/game-server-nodes");
  });

  // GameUpdate is sent without one, so gating the fallback on entity_id left
  // its route unreachable by the only rows that have it.
  it("takes a route that needs no id without an entity_id", () => {
    expect(
      notificationUrl(
        { type: "GameUpdate", message: "A CS2 Update has been detected." },
        webDomain,
      ),
    ).toBe("/game-server-nodes");
  });

  it("still needs an entity_id for a route built from one", () => {
    expect(
      notificationUrl({ type: "MatchStatusChange", message: "" }, webDomain),
    ).toBe("/");
  });
});
