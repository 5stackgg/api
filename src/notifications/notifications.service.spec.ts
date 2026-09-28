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
    "MatchImported",
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
