import { e_notification_types_enum } from "generated/schema";

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
  chat: ["ChatMessage"],
  tournaments: ["TournamentCreated", "TournamentReminder"],
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
  invites: ["TeamInvite", "TournamentTeamInvite", "DraftInvite"],
  account: ["NameChangeApproved", "NameChangeDenied", "PlayerSanctioned", "AwardGranted"],
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
  ],
};

export const PUSH_KEYS: PreferenceKey[] = [
  { key: "matches", defaultEnabled: true },
  { key: "chat", defaultEnabled: true },
  { key: "tournaments", defaultEnabled: true },
  { key: "events", defaultEnabled: true },
  { key: "seasons", defaultEnabled: true },
  { key: "scrims", defaultEnabled: true },
  { key: "leagues", defaultEnabled: true },
  { key: "teams", defaultEnabled: true },
  { key: "invites", defaultEnabled: true },
  { key: "account", defaultEnabled: true },
  { key: "news", defaultEnabled: true },
  { key: "staff_moderation", defaultEnabled: true, adminOnly: true },
  // Infrastructure chatter is constant and rarely actionable on a phone.
  { key: "staff_infrastructure", defaultEnabled: false, adminOnly: true },
];

// The in-app bell is toggleable per individual type rather than per category,
// but only for a small hand-picked set -- everything else keeps firing with no
// user-facing control.
//
// Every key here must be a type that carries a steam_id. Enforcement happens at
// insert time against a known recipient list, and a role-broadcast row has no
// such list to filter against.
export const IN_APP_KEYS: PreferenceKey[] = [
  { key: "ChatMessage", defaultEnabled: true },
  { key: "TeamInvite", defaultEnabled: true },
  { key: "TournamentTeamInvite", defaultEnabled: true },
  { key: "DraftInvite", defaultEnabled: true },
  { key: "MatchImported", defaultEnabled: false },
  { key: "MatchStatsReady", defaultEnabled: true },
  { key: "ClipReady", defaultEnabled: true },
  { key: "AwardGranted", defaultEnabled: true },
  { key: "NewsPublished", defaultEnabled: true },
  { key: "TournamentReminder", defaultEnabled: true },
  { key: "EventReminder", defaultEnabled: true },
  { key: "SeasonEnded", defaultEnabled: true },
  { key: "FormTeamSuggestion", defaultEnabled: true },
  { key: "ScrimAlertMatch", defaultEnabled: true },
  { key: "LeagueMatchUnscheduled", defaultEnabled: true },
];

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

export function keysForChannel(channel: NotificationChannel): PreferenceKey[] {
  return channel === "push" ? PUSH_KEYS : IN_APP_KEYS;
}

export function isKnownKey(
  channel: NotificationChannel,
  key: string,
): boolean {
  return keysForChannel(channel).some((entry) => entry.key === key);
}
