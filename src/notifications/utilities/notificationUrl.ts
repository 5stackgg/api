import { load } from "cheerio";

// Where a push notification should take you when tapped.
//
// Most notification messages already embed the correct in-app link (the bell
// renders them as real anchors), so the href is read straight back out rather
// than duplicating a type -> route map that would immediately drift. The map
// below is only the fallback for messages authored without a link.
const PATH_BY_TYPE: Record<string, (entityId: string) => string> = {
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
  ScrimMatchScheduled: () => `/scrims`,
  ScrimMatchCanceled: () => `/scrims`,
  ScrimTimeChanged: () => `/scrims`,
  ScrimAlertMatch: () => `/scrims`,
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

  return notification.entity_id && path ? path(notification.entity_id) : "/";
}
