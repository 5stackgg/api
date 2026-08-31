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
