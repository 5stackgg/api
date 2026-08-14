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
  let subscriptions: Array<ReturnType<typeof subscription>>;
  let updates: Array<{ sql: string; bindings: any[] }>;

  // Keys are resolved from settings (with env taking precedence), so they are
  // not known until loadKeys() runs.
  const build = async () => {
    const service = new PushNotificationsService(
      logger as any,
      postgres as any,
      configService as any,
    );
    await service.loadKeys();
    return service;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    withEnvKeys();
    notificationRow = notification();
    subscriptions = [subscription("sub-1")];
    updates = [];

    postgres.query.mockImplementation(async (sql: string, bindings: any[]) => {
      if (sql.includes("FROM public.notifications\n")) {
        return notificationRow ? [notificationRow] : [];
      }
      if (sql.includes("push_subscriptions ps")) {
        return subscriptions;
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
            bindings[0] === "web_push_private_key",
        ),
      ).toBe(true);
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
