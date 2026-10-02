import { e_notification_types_enum } from "generated/schema";
import { deliveryPolicyForType } from "../push/notification-delivery";

export type NotificationChannel = "push" | "in_app";

export const NOTIFICATION_CHANNELS: NotificationChannel[] = ["push", "in_app"];

export type PreferenceKey = {
  key: string;
  defaultEnabled: boolean;
  // Only ever reaches staff, so the frontend hides it from everyone else
  // rather than offering a toggle that can never do anything.
  adminOnly?: boolean;
};

// Push groups every notification type into a coarse category. There are ~35
// types and a switch per type would be unusable, so a player mutes a whole
// category at once.
//
// Keep this exhaustive: notification-categories.spec.ts reads the real type
// list out of hasura/enums/notification-types.sql *and* the migrations that
// insert into e_notification_types (MatchImported only exists in the latter),
// and fails if anything is unmapped.
export const PUSH_CATEGORIES: Record<string, e_notification_types_enum[]> = {
  matches: ["MatchStatusChange", "MatchImported", "MatchStatsReady", "ClipReady"],
  match_found: ["MatchFound"],
  admin_call: ["AdminCall"],
  chat: ["ChatMessage"],
  match_chat: ["MatchChatMessage"],
  tournaments: [
    "TournamentCreated",
    "TournamentReminder",
    "TournamentCheckInOpen",
    "TournamentCheckInClosing",
    "TournamentCheckInMissed",
    "TournamentPartySignup",
  ],
  events: ["EventReminder"],
  seasons: ["SeasonEnded"],
  scrims: [
    "ScrimRequestReceived",
    "ScrimRequestCountered",
    "ScrimRequestAccepted",
    "ScrimRequestDeclined",
    "ScrimRequestExpired",
    "ScrimMatchScheduled",
    "ScrimMatchCanceled",
    "ScrimTimeChanged",
    "ScrimAlertMatch",
  ],
  leagues: [
    "LeagueProposalReceived",
    "LeagueProposalAccepted",
    "LeagueProposalDeclined",
    "LeagueMatchUnscheduled",
    "LeagueRegistrationDecision",
    "LeagueRosterUndersized",
  ],
  teams: ["FormTeamSuggestion"],
  invites: [
    "TeamInvite",
    "TournamentTeamInvite",
    "TournamentInvite",
    "DraftInvite",
  ],
  utility: ["UtilityPracticeInvite", "UtilityPracticeReady"],
  account: [
    "NameChangeApproved",
    "NameChangeDenied",
    "PlayerSanctioned",
    "PlayerWarning",
    "AwardGranted",
  ],
  teammate_bans: ["TeammateBanned"],
  news: ["NewsPublished"],
  staff_moderation: ["MatchSupport", "MatchAbandoned", "NameChangeRequest"],
  staff_infrastructure: [
    "GameUpdate",
    "GameNodeStatus",
    "DedicatedServerStatus",
    "DedicatedServerRconStatus",
    "StorageScan",
    "EloRecompute",
    "PlayerReindex",
    "UtilityDriftScanFinished",
  ],
};

export const PUSH_KEYS: PreferenceKey[] = [
  { key: "matches", defaultEnabled: true },
  { key: "match_found", defaultEnabled: true },
  { key: "admin_call", defaultEnabled: true },
  { key: "chat", defaultEnabled: true },
  // Off by default. In-game chat is relayed into the match's room line by
  // line, so this is the one category that fires constantly and reaches the
  // player least able to act on it -- they are in the game, reading it there.
  { key: "match_chat", defaultEnabled: false },
  { key: "tournaments", defaultEnabled: true },
  { key: "events", defaultEnabled: true },
  { key: "seasons", defaultEnabled: true },
  { key: "scrims", defaultEnabled: true },
  { key: "leagues", defaultEnabled: true },
  { key: "teams", defaultEnabled: true },
  { key: "invites", defaultEnabled: true },
  { key: "utility", defaultEnabled: true },
  { key: "account", defaultEnabled: true },
  { key: "teammate_bans", defaultEnabled: true },
  { key: "news", defaultEnabled: true },
  { key: "staff_moderation", defaultEnabled: true, adminOnly: true },
  // Infrastructure chatter is constant and rarely actionable on a phone.
  { key: "staff_infrastructure", defaultEnabled: false, adminOnly: true },
];

// The in-app bell is toggleable per individual type rather than per category,
// for every type that reaches a player by steam id -- except the ones in
// LOCKED_IN_APP_TYPES and PUSH_ONLY_TYPES.
//
// Enforcement happens at insert time against a known recipient list, so a type
// only belongs here if every per-player write of it goes through
// NotificationsService.notifyPlayers or notifyActivePlayers. A role-broadcast
// row has no such list to filter against, which is why staff types are absent.
export const IN_APP_KEYS: PreferenceKey[] = [
  { key: "MatchStatusChange", defaultEnabled: true },
  { key: "MatchImported", defaultEnabled: true },
  { key: "MatchStatsReady", defaultEnabled: true },
  { key: "ClipReady", defaultEnabled: true },
  { key: "TournamentCreated", defaultEnabled: true },
  { key: "TournamentReminder", defaultEnabled: true },
  { key: "TournamentCheckInOpen", defaultEnabled: true },
  { key: "TournamentCheckInClosing", defaultEnabled: true },
  { key: "TournamentCheckInMissed", defaultEnabled: true },
  { key: "TournamentPartySignup", defaultEnabled: true },
  { key: "EventReminder", defaultEnabled: true },
  { key: "SeasonEnded", defaultEnabled: true },
  { key: "ScrimRequestReceived", defaultEnabled: true },
  { key: "ScrimRequestCountered", defaultEnabled: true },
  { key: "ScrimRequestAccepted", defaultEnabled: true },
  { key: "ScrimRequestDeclined", defaultEnabled: true },
  { key: "ScrimRequestExpired", defaultEnabled: true },
  { key: "ScrimMatchScheduled", defaultEnabled: true },
  { key: "ScrimMatchCanceled", defaultEnabled: true },
  { key: "ScrimTimeChanged", defaultEnabled: true },
  { key: "ScrimAlertMatch", defaultEnabled: true },
  { key: "LeagueProposalReceived", defaultEnabled: true },
  { key: "LeagueProposalAccepted", defaultEnabled: true },
  { key: "LeagueProposalDeclined", defaultEnabled: true },
  { key: "LeagueMatchUnscheduled", defaultEnabled: true },
  { key: "LeagueRegistrationDecision", defaultEnabled: true },
  { key: "LeagueRosterUndersized", defaultEnabled: true },
  { key: "FormTeamSuggestion", defaultEnabled: true },
  { key: "TeamInvite", defaultEnabled: true },
  { key: "TournamentTeamInvite", defaultEnabled: true },
  { key: "TournamentInvite", defaultEnabled: true },
  { key: "DraftInvite", defaultEnabled: true },
  { key: "UtilityPracticeInvite", defaultEnabled: true },
  { key: "UtilityPracticeReady", defaultEnabled: true },
  { key: "AwardGranted", defaultEnabled: true },
  { key: "TeammateBanned", defaultEnabled: true },
  { key: "NewsPublished", defaultEnabled: true },
];

// A player's own account and safety notices always reach the bell.
export const LOCKED_IN_APP_TYPES: e_notification_types_enum[] = [
  "NameChangeApproved",
  "NameChangeDenied",
  "PlayerSanctioned",
  "PlayerWarning",
];

// Rings are written with in_app = false, and chat writes no rows at all.
export const PUSH_ONLY_TYPES: e_notification_types_enum[] = [
  "MatchFound",
  "AdminCall",
  "ChatMessage",
  "MatchChatMessage",
];

export type BellControl = "toggle" | "locked" | "push_only";

export type CategoryType = {
  type: string;
  bell: BellControl;
  ignoresQuietHours: boolean;
};

const PUSH_CATEGORY_BY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(PUSH_CATEGORIES).flatMap(([category, types]) =>
    types.map((type) => [type, category]),
  ),
);

const PUSH_KEY_BY_NAME = new Map(PUSH_KEYS.map((entry) => [entry.key, entry]));
const IN_APP_KEY_BY_NAME = new Map(
  IN_APP_KEYS.map((entry) => [entry.key, entry]),
);

export function pushCategoryForType(type: string): PreferenceKey | null {
  const category = PUSH_CATEGORY_BY_TYPE[type];
  return category ? (PUSH_KEY_BY_NAME.get(category) ?? null) : null;
}

export function inAppKeyForType(type: string): PreferenceKey | null {
  return IN_APP_KEY_BY_NAME.get(type) ?? null;
}

export function bellControlForType(type: string): BellControl | null {
  if (IN_APP_KEY_BY_NAME.has(type)) {
    return "toggle";
  }

  if ((PUSH_ONLY_TYPES as string[]).includes(type)) {
    return "push_only";
  }

  if (
    (LOCKED_IN_APP_TYPES as string[]).includes(type) ||
    pushCategoryForType(type)?.adminOnly
  ) {
    return "locked";
  }

  return null;
}

export function typesForCategory(category: string): CategoryType[] {
  return (PUSH_CATEGORIES[category] ?? []).map((type) => ({
    type,
    bell: bellControlForType(type) ?? "locked",
    ignoresQuietHours: Boolean(deliveryPolicyForType(type)?.ignoreQuietHours),
  }));
}

export function keysForChannel(channel: NotificationChannel): PreferenceKey[] {
  return channel === "push" ? PUSH_KEYS : IN_APP_KEYS;
}

export function isKnownKey(channel: NotificationChannel, key: string): boolean {
  return keysForChannel(channel).some((entry) => entry.key === key);
}
