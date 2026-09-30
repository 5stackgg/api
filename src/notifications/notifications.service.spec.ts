import { readFileSync } from "fs";
import { join } from "path";
import { NotificationsService } from "./notifications.service";
import { PUSH_CATEGORIES } from "./preferences/notification-categories";

const STAFF_CATEGORIES = ["staff_moderation", "staff_infrastructure"];

// Same source notification-categories.spec.ts reads. Only the seed file is
// needed here: the one type that lives solely in a migration (MatchImported) is
// per-player, and the allowlist below is checked against PUSH_CATEGORIES, which
// that suite already proves exhaustive against the whole tree.
const declaredTypes = (): string[] => {
  const sql = readFileSync(
    join(__dirname, "../../hasura/enums/notification-types.sql"),
    "utf8",
  );

  return [...sql.matchAll(/\('([A-Za-z]+)',\s*'/g)].map(([, value]) => value);
};

// The support webhook is a staff channel, and whatever reaches it is posted
// there verbatim. Routing used to be a denylist, which made Discord the default
// for every type anyone added -- tournament invites, check-in reminders and
// free-agent signups, each of them addressed to one player, ended up in a staff
// channel that way. These assertions are about the SHAPE of the routing: a type
// nobody has classified must be silent.
describe("discord routing", () => {
  it("keeps a type nobody has classified off discord", () => {
    expect(NotificationsService.relaysToDiscord("SomeTypeAddedNextWeek")).toBe(
      false,
    );
  });

  it.each([
    "TournamentInvite",
    "TournamentTeamInvite",
    "TeamInvite",
    "DraftInvite",
    "TournamentPartySignup",
    "TournamentCheckInOpen",
    "TournamentCheckInClosing",
    "TournamentCheckInMissed",
    "TournamentReminder",
    "EventReminder",
    "AwardGranted",
    "ClipReady",
    "MatchStatsReady",
    "NameChangeApproved",
    "NameChangeDenied",
    "ChatMessage",
    "MatchChatMessage",
    "PlayerSanctioned",
    "PlayerWarning",
    "MatchImported",
    "MatchFound",
    "AdminCall",
  ])("keeps %s off discord", (type) => {
    expect(NotificationsService.relaysToDiscord(type)).toBe(false);
  });

  it("relays nothing it was not explicitly given", () => {
    const relayed = declaredTypes().filter(
      (type) =>
        NotificationsService.relaysToDiscord(type) &&
        !NotificationsService.DISCORD_TYPES.has(type),
    );

    expect(relayed).toEqual([]);
  });

  // Guards the assertions above: an allowlist that let nothing through would
  // pass every one of them for the wrong reason.
  it.each([
    "DedicatedServerRconStatus",
    "DedicatedServerStatus",
    "GameNodeStatus",
    "GameUpdate",
    "StorageScan",
    "EloRecompute",
    "PlayerReindex",
    "UtilityDriftScanFinished",
    "NameChangeRequest",
    "MatchSupport",
    "MatchAbandoned",
  ])("still relays %s", (type) => {
    expect(NotificationsService.relaysToDiscord(type)).toBe(true);
  });

  // A typo in the allowlist would silently mute an ops alert, and a per-player
  // type slipped into it is the whole bug coming back. Both show up as an entry
  // that is not one of the staff push categories.
  it("only relays types the push preferences also treat as staff", () => {
    const staff = new Set(
      STAFF_CATEGORIES.flatMap((category) => PUSH_CATEGORIES[category]),
    );

    const offenders = [...NotificationsService.DISCORD_TYPES].filter(
      (type) => !staff.has(type as never),
    );

    expect(offenders).toEqual([]);
  });
});

describe("CS2 build notices", () => {
  const originalDomain = process.env.WEB_DOMAIN;
  const originalFetch = global.fetch;

  const service = () =>
    new NotificationsService(
      { mutation: jest.fn() } as any,
      { query: jest.fn() } as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: () => ({ webDomain: "https://5stack.gg" }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  afterEach(() => {
    process.env.WEB_DOMAIN = originalDomain;
    global.fetch = originalFetch;
  });

  it("stacks every notice for a build and links to its history", async () => {
    process.env.WEB_DOMAIN = "5stack.gg";
    const notifications = service();
    const send = jest.spyOn(notifications, "send").mockResolvedValue();

    await notifications.sendCs2Build(25537370, {
      title: "Map Assets Published",
      message: "done",
      color: 1,
    });

    expect(send).toHaveBeenCalledWith(
      "GameUpdate",
      {
        title: "Map Assets Published",
        message:
          'done<br><a href="https://5stack.gg/game-server-nodes/builds?build=25537370">View build 25537370</a>',
        role: "administrator",
        entity_id: "cs2-build:25537370",
      },
      undefined,
      1,
      undefined,
      NotificationsService.CS2_BUILD_ROUTING,
    );
  });

  it("links to the node list where no build history is kept", () => {
    process.env.WEB_DOMAIN = "example.com";

    expect(service().cs2BuildUrl(25537370)).toBe(
      "https://5stack.gg/game-server-nodes",
    );
  });

  it("mentions every role in a comma-separated list", async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetch as any;

    await (service() as any).postDiscord("https://discord.test/hook", "1, 2", {
      title: "t",
      message: "m",
    });

    expect(JSON.parse(fetch.mock.calls[0][1].body).content).toBe("<@&1> <@&2>");
  });

  it("keeps an embed description under Discord's limit", () => {
    const long = "x".repeat(5000);

    expect(NotificationsService.truncateDiscord(long)).toHaveLength(4000);
    expect(NotificationsService.truncateDiscord("short")).toBe("short");
  });
});

describe("push-only rings", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let preferences: { filterInAppRecipients: jest.Mock };
  let pushNotifications: {
    filterSubscribed: jest.Mock;
    claimFanOut: jest.Mock;
    sendForIds: jest.Mock;
  };
  let pushBroadcastQueue: { add: jest.Mock };
  let service: NotificationsService;

  beforeEach(() => {
    jest.clearAllMocks();

    hasura = {
      query: jest.fn().mockResolvedValue({ settings_by_pk: null }),
      mutation: jest.fn(async (mutation: any) => ({
        insert_notifications: {
          returning: mutation.insert_notifications.__args.objects.map(
            (_: unknown, index: number) => ({ id: `row-${index}` }),
          ),
        },
      })),
    };
    postgres = { query: jest.fn().mockResolvedValue([]) };
    preferences = {
      filterInAppRecipients: jest.fn(async (_type, steamIds) => steamIds),
    };
    pushNotifications = {
      filterSubscribed: jest.fn(async (steamIds: string[]) => steamIds),
      claimFanOut: jest.fn().mockResolvedValue(undefined),
      sendForIds: jest.fn().mockResolvedValue(undefined),
    };
    pushBroadcastQueue = { add: jest.fn().mockResolvedValue({}) };

    service = new NotificationsService(
      hasura as any,
      postgres as any,
      logger as any,
      { get: () => ({ webDomain: "https://example.com" }) } as any,
      preferences as any,
      pushNotifications as any,
      { add: jest.fn() } as any,
      pushBroadcastQueue as any,
    );
  });

  const insertedRows = () =>
    hasura.mutation.mock.calls[0][0].insert_notifications.__args.objects;

  it("writes rings out of the bell without asking the bell's preference", async () => {
    await service.notifyMatchFound("confirmation-1", ["1", "2"], "Wingman", 30);

    expect(preferences.filterInAppRecipients).not.toHaveBeenCalled();
    expect(insertedRows().map(({ in_app }: any) => in_app)).toEqual([
      false,
      false,
    ]);
  });

  // The broadcast worker runs one job at a time; behind a news fan-out a ready
  // check would expire before its push was ever sent.
  it("sends a ready check straight away rather than queueing it", async () => {
    await service.notifyMatchFound("confirmation-1", ["1", "2"], "Wingman", 30);

    expect(pushBroadcastQueue.add).not.toHaveBeenCalled();
    expect(pushNotifications.claimFanOut).toHaveBeenCalledWith([
      "row-0",
      "row-1",
    ]);
    expect(pushNotifications.sendForIds).toHaveBeenCalledWith([
      "row-0",
      "row-1",
    ]);
  });

  it("still queues every other fan-out", async () => {
    await service.notifyPlayers("ScrimAlertMatch", {
      title: "Scrim",
      message: "A team is available",
      role: "user",
      entity_id: "alert-1",
      steamIds: ["1", "2"],
    });

    expect(pushBroadcastQueue.add).toHaveBeenCalled();
    expect(pushNotifications.sendForIds).not.toHaveBeenCalled();
  });

  it("swallows a failed urgent send rather than failing the writer", async () => {
    pushNotifications.sendForIds.mockRejectedValue(new Error("db away"));

    await expect(
      service.notifyMatchFound("confirmation-1", ["1", "2"], "Wingman", 30),
    ).resolves.toBe(2);
  });

  // A team named after its captain carries whatever that player called
  // themselves, and the message is read back as HTML for its link and text.
  it("escapes the match name an admin call is about", async () => {
    postgres.query.mockImplementation(async (sql: string) =>
      sql.includes("get_team_name")
        ? [{ label: `<a href="/settings">Evil</a>'s Team vs Team 2` }]
        : [],
    );

    await service.notifyAdminCall("m-1", "1");

    expect(insertedRows()[0].message).toBe(
      "An admin wants to talk to you about &lt;a href=&quot;/settings&quot;&gt;Evil&lt;/a&gt;&#39;s Team vs Team 2. Open your camera page to answer.",
    );
  });

  it("clears the previous ring before writing a new one", async () => {
    const order: string[] = [];
    postgres.query.mockImplementation(async (sql: string, bindings: any[]) => {
      if (sql.includes("DELETE")) {
        order.push(`retract ${bindings.join(" ")}`);
      }
      return [];
    });
    const insert = hasura.mutation.getMockImplementation();
    hasura.mutation.mockImplementation(async (mutation: any) => {
      order.push("insert");
      return insert(mutation);
    });

    await service.notifyAdminCall("m-1", "1");

    expect(order).toEqual(["retract m-1 1", "insert"]);
  });
});

describe("NotificationsService", () => {
  const webDomain = "https://5stack.test";
  let service: NotificationsService;
  let postgres: { query: jest.Mock };
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifyPlayers: jest.SpyInstance;

  const sanction = (type: string) => ({
    sanctionId: "sanction-1",
    steamId: "76561198000000001",
    type,
    reason: "cheating",
  });

  beforeEach(() => {
    postgres = {
      query: jest.fn().mockResolvedValue([{ steam_id: "76561198000000002" }]),
    };
    hasura = {
      query: jest.fn().mockResolvedValue({ players_by_pk: { name: "keith" } }),
      mutation: jest.fn().mockResolvedValue({}),
    };

    service = new NotificationsService(
      hasura as any,
      postgres as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: jest.fn(() => ({ webDomain })) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    notifyPlayers = jest.spyOn(service, "notifyPlayers").mockResolvedValue(1);
  });

  describe("playerProfileLink", () => {
    it("links to the absolute profile url", () => {
      expect(service.playerProfileLink("76561198000000001", "keith")).toBe(
        `<a href="${webDomain}/players/76561198000000001">keith</a>`,
      );
    });

    it("escapes the name and encodes the steam id", () => {
      expect(
        service.playerProfileLink('1"><x', `<img src=x onerror="alert('1')">`),
      ).toBe(
        `<a href="${webDomain}/players/1%22%3E%3Cx">` +
          `&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;</a>`,
      );
    });
  });

  describe("notifyMatchPlayersOfSanction", () => {
    it.each(["mute", "gag", "silence", "warning"])(
      "keeps a %s between the player and staff",
      async (type) => {
        await service.notifyMatchPlayersOfSanction(sanction(type));

        expect(postgres.query).not.toHaveBeenCalled();
        expect(notifyPlayers).not.toHaveBeenCalled();
      },
    );

    it("tells recent team-mates about a ban", async () => {
      await service.notifyMatchPlayersOfSanction(sanction("ban"));

      expect(notifyPlayers).toHaveBeenCalledTimes(1);
      const [type, notification] = notifyPlayers.mock.calls[0];
      expect(type).toBe("PlayerSanctioned");
      expect(notification.steamIds).toEqual(["76561198000000002"]);
      expect(notification.message).toContain(
        `<a href="${webDomain}/players/76561198000000001">keith</a>, was banned. (cheating)`,
      );
    });
  });

  describe("warnings", () => {
    const signedIn = () =>
      hasura.query.mockResolvedValue({
        players_by_pk: { last_sign_in_at: "2026-09-01T00:00:00.000Z" },
      });

    it("tells only the warned player, with the reason escaped", async () => {
      signedIn();

      await service.notifyWarnedPlayer({
        ...sanction("warning"),
        reason: `<b>spam</b> & "toxic"`,
      });

      expect(notifyPlayers).toHaveBeenCalledTimes(1);
      const [type, notification] = notifyPlayers.mock.calls[0];
      expect(type).toBe("PlayerWarning");
      expect(notification).toEqual({
        title: "You received a warning",
        message: "&lt;b&gt;spam&lt;/b&gt; &amp; &quot;toxic&quot;",
        role: "user",
        entity_id: "76561198000000001",
        steamIds: ["76561198000000001"],
      });
    });

    it("skips a player who has never signed in", async () => {
      hasura.query.mockResolvedValue({
        players_by_pk: { last_sign_in_at: null },
      });

      await service.notifyWarnedPlayer(sanction("warning"));

      expect(notifyPlayers).not.toHaveBeenCalled();
    });

    it.each(["ban", "mute", "gag", "silence"])("ignores a %s", async (type) => {
      signedIn();

      await service.notifyWarnedPlayer(sanction(type));

      expect(hasura.query).not.toHaveBeenCalled();
      expect(notifyPlayers).not.toHaveBeenCalled();
    });

    it("never reaches admins or the banned-player notice", async () => {
      signedIn();

      await service.notifyBannedPlayer(sanction("warning"));
      await service.notifyAdminsOfBan(sanction("warning"));

      expect(hasura.query).not.toHaveBeenCalled();
      expect(hasura.mutation).not.toHaveBeenCalled();
      expect(postgres.query).not.toHaveBeenCalled();
    });
  });
});

describe("latestTitle", () => {
  it("reads the newest matching alert for the entity, dismissed ones included", async () => {
    const hasura = {
      query: jest
        .fn()
        .mockResolvedValue({ notifications: [{ title: "Region Offline" }] }),
    };
    const service = new NotificationsService(
      hasura as any,
      {} as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: () => ({ webDomain: "https://5stack.gg" }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.latestTitle("GameNodeStatus", "us-east", [
        "Region Offline",
        "Region Online",
      ]),
    ).resolves.toBe("Region Offline");

    expect(hasura.query.mock.calls[0][0].notifications.__args).toEqual({
      where: {
        type: { _eq: "GameNodeStatus" },
        entity_id: { _eq: "us-east" },
        title: { _in: ["Region Offline", "Region Online"] },
      },
      order_by: [{ created_at: "desc" }],
      limit: 1,
    });
  });

  it("is null when the entity has never alerted", async () => {
    const service = new NotificationsService(
      { query: jest.fn().mockResolvedValue({ notifications: [] }) } as any,
      {} as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: () => ({ webDomain: "https://5stack.gg" }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.latestTitle("GameNodeStatus", "node-1", [
        "Game Server Node Offline",
      ]),
    ).resolves.toBeNull();
  });
});
