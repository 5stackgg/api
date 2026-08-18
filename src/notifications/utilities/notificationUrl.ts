import { load } from "cheerio";

// Where a push notification should take you when tapped.
//
// Most notification messages already embed the correct in-app link (the bell
// renders them as real anchors), so the href is read straight back out rather
// than duplicating a type -> route map that would immediately drift. The map
// below is only the fallback for messages authored without a link.
const PATH_BY_TYPE: Record<string, (entityId: string) => string> = {
  // entity_id is `${lobbyType}:${lobbyId}`, which is already the client's tab
  // id -- see web/composables/useDirectMessages.ts directTabId.
  ChatMessage: (id) => `/chat/${encodeURIComponent(id)}`,
  MatchChatMessage: (id) => `/chat/${encodeURIComponent(id)}`,
  MatchStatusChange: (id) => `/matches/${id}`,
  MatchImported: (id) => `/matches/${id}`,
  MatchSupport: (id) => `/matches/${id}`,
  MatchAbandoned: (id) => `/matches/${id}`,
  TournamentCreated: (id) => `/tournaments/${id}`,
  TournamentReminder: (id) => `/tournaments/${id.split(":")[0]}`,
  NewsPublished: () => `/news`,
  ScrimRequestReceived: () => `/scrims`,
  ScrimRequestCountered: () => `/scrims`,
  ScrimRequestAccepted: () => `/scrims`,
  ScrimRequestDeclined: () => `/scrims`,
  ScrimRequestExpired: () => `/scrims`,
  ScrimMatchScheduled: () => `/scrims`,
  ScrimMatchCanceled: () => `/scrims`,
  ScrimTimeChanged: () => `/scrims`,
  ScrimAlertMatch: () => `/scrims`,
  // entity_id is the draft game itself, so this one lands on the lobby it is
  // inviting you to. The other two invites are keyed by the invite row rather
  // than the thing invited to, and both are accepted from the bell wherever
  // you are, so they only have to put you somewhere they make sense from.
  DraftInvite: (id) => `/draft-room/${id}`,
  TeamInvite: () => `/teams`,
  TournamentTeamInvite: () => `/tournaments`,
  // entity_id is the grant, not the award, and there is no page for a grant.
  AwardGranted: () => `/awards`,
  // Where the name was requested, which is where the outcome belongs.
  NameChangeApproved: () => `/settings`,
  NameChangeDenied: () => `/settings`,
  NameChangeRequest: (id) => `/players/${id}`,
  // A league notification is keyed by a bracket or a team's season entry,
  // neither of which is addressable on its own -- the season id that would
  // build /league/seasons/:id is not on the row.
  LeagueProposalReceived: () => `/league`,
  LeagueProposalAccepted: () => `/league`,
  LeagueProposalDeclined: () => `/league`,
  LeagueMatchUnscheduled: () => `/league`,
  LeagueRegistrationDecision: () => `/league`,
  LeagueRosterUndersized: () => `/league`,
  GameNodeStatus: () => `/game-server-nodes`,
  GameUpdate: () => `/game-server-nodes`,
  DedicatedServerStatus: () => `/dedicated-servers`,
  DedicatedServerRconStatus: () => `/dedicated-servers`,
};

export function notificationUrl(
  notification: { type: string; message?: string; entity_id?: string | null },
  webDomain: string,
): string {
  const href = load(String(notification.message ?? ""))("a[href]")
    .first()
    .attr("href");

  // The trailing slash matters: without it `https://5stack.gg.evil.test/x` is
  // also a prefix match.
  if (href === webDomain) {
    return "/";
  }

  if (href?.startsWith(`${webDomain}/`)) {
    return href.slice(webDomain.length);
  }

  // Not `startsWith("/")` on its own: `//evil.test/x` passes that and is a
  // fully qualified URL to somewhere else, which the service worker would hand
  // straight to clients.openWindow.
  if (href?.startsWith("/") && !href.startsWith("//")) {
    return href;
  }

  const path = PATH_BY_TYPE[notification.type];

  if (!path) {
    return "/";
  }

  // Arity says whether the route needs the id, so the static ones still resolve
  // for a type whose rows carry no entity_id -- GameUpdate is sent without one.
  return path.length === 0 || notification.entity_id
    ? path(notification.entity_id ?? "")
    : "/";
}
