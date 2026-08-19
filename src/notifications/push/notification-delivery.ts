import { e_notification_types_enum } from "generated/schema";

export type DeliveryPolicy = {
  // How long to hold the window open after the first push of a burst. The
  // first message always goes out immediately; everything that lands inside
  // the window collapses into one replacement summary when it closes.
  //
  // 0 disables windowing entirely -- one push per row, as before.
  bundleSeconds: number;
  // Drop the push if the bell row has been read or dismissed by the time it is
  // sent. For chat this also means "the recipient's read cursor for the thread
  // has moved past this message".
  requireUnseen: boolean;
};

// Notifications differ in how much a delayed or dropped buzz costs, and that
// difference is the whole of this table.
//
// An invite is worth a buzz the moment it exists and there is never a second
// one to collapse it with. A chat message is worth a buzz only if the recipient
// isn't already reading the conversation, and a burst of them is worth exactly
// one. Infrastructure alerts fire in clusters when a node wobbles and nobody
// needs each individual flap on their phone.
//
// Keep this exhaustive: notification-delivery.spec.ts reads the real type list
// out of the tree and fails if anything is unmapped.
const DELIVERY_POLICIES: Record<string, e_notification_types_enum[]> = {
  // Conversations. The only type where the recipient is routinely staring at
  // the thing being pushed to them.
  "15s-unseen": ["ChatMessage", "MatchChatMessage"],

  // A match alert describes a condition, and conditions flap -- pause, resume,
  // pause again. They are also retracted wholesale by resolveMatchAlerts, so a
  // window that outlives the condition should send nothing at all.
  "30s-unseen": ["MatchStatusChange"],

  // Actionable and singular: buzz immediately, but not if it was already dealt
  // with in-app between the insert and the send.
  "instant-unseen": [
    "TeamInvite",
    "TournamentTeamInvite",
    "DraftInvite",
    "MatchImported",
    "MatchStatsReady",
    "ClipReady",
    "AwardGranted",
    "NameChangeApproved",
    "NameChangeDenied",
    "PlayerSanctioned",
    "TournamentReminder",
    "EventReminder",
    "SeasonEnded",
    "FormTeamSuggestion",
    "ScrimRequestReceived",
    "ScrimRequestCountered",
    "ScrimRequestAccepted",
    "ScrimRequestDeclined",
    "ScrimRequestExpired",
    "ScrimMatchScheduled",
    "ScrimMatchCanceled",
    "ScrimTimeChanged",
    "ScrimAlertMatch",
    "LeagueProposalReceived",
    "LeagueProposalAccepted",
    "LeagueProposalDeclined",
    "LeagueMatchUnscheduled",
    "LeagueRegistrationDecision",
    "LeagueRosterUndersized",
    "NadePracticeInvite",
    // A practice server is up for as long as somebody is on it and the reaper
    // stops it when nobody is: a late buzz sends a player to a session that has
    // already been torn down, so this one is worth nothing bundled.
    "NadePracticeReady",
  ],

  // Fan-outs to the whole player base. Already collapsed into one job by
  // BATCHED_TYPES; the short window is what absorbs the trigger burst.
  //
  // Not requireUnseen: these are role/announcement rows whose bell entry is
  // routinely left unread for days, and a "seen" check would be measuring
  // nothing.
  "5s": ["TournamentCreated", "NewsPublished"],

  // Staff broadcasts. A wobbling node emits a run of these, and the second one
  // is never news.
  "60s": [
    "MatchSupport",
    "MatchAbandoned",
    "NameChangeRequest",
    "GameUpdate",
    "GameNodeStatus",
    "DedicatedServerStatus",
    "DedicatedServerRconStatus",
    "StorageScan",
    "EloRecompute",
    "PlayerReindex",
    "NadeDriftScanFinished",
  ],
};

const POLICY_BY_NAME: Record<string, DeliveryPolicy> = {
  "15s-unseen": { bundleSeconds: 15, requireUnseen: true },
  "30s-unseen": { bundleSeconds: 30, requireUnseen: true },
  "instant-unseen": { bundleSeconds: 0, requireUnseen: true },
  "5s": { bundleSeconds: 5, requireUnseen: false },
  "60s": { bundleSeconds: 60, requireUnseen: false },
};

// Matches the pre-existing behaviour, so an uncategorised type keeps being
// delivered the way it always was rather than silently going quiet.
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  bundleSeconds: 0,
  requireUnseen: false,
};

const POLICY_BY_TYPE: Record<string, DeliveryPolicy> = Object.fromEntries(
  Object.entries(DELIVERY_POLICIES).flatMap(([name, types]) =>
    types.map((type) => [type, POLICY_BY_NAME[name]]),
  ),
);

export function deliveryPolicyForType(type: string): DeliveryPolicy | null {
  return POLICY_BY_TYPE[type] ?? null;
}

export { DELIVERY_POLICIES };

// Which conversation, match or announcement a notification belongs to.
//
// This is what the device collapses on, what the delivery window is keyed by,
// and what a focused client reports to say "I am looking at this right now" --
// all three have to agree or the gate leaks, so they all come from here.
//
// `data.threadKey` wins when the writer set one: chat's entity_id is already
// `${type}:${id}`, but a writer that knows better should be able to say so.
export function threadKeyFor(notification: {
  type: string;
  entity_id?: string | null;
  data?: { threadKey?: string } | null;
}): string {
  const explicit = notification.data?.threadKey;

  if (explicit) {
    return explicit;
  }

  return `${notification.type}:${notification.entity_id ?? ""}`;
}

// A chat thread's key. `chat:` distinguishes the conversation from the
// notification type that happens to be announcing it, so the same string works
// as a read cursor, a focus report and a device tag.
export function chatThreadKey(type: string, id: string): string {
  return `chat:${type}:${id}`;
}

// Where a client's focus reports land. Read by the delivery gate and written by
// the socket gateway, which is why it lives here with the key it holds rather
// than on either side of that exchange -- the two modules would otherwise have
// to import each other to agree on a string.
export function presenceFocusKey(steamId: string): string {
  return `presence:focus:${steamId}`;
}
