import { NotificationsService } from "./notifications.service";

// The discord support webhook is a staff channel, and notifyPlayers posts to it
// for every type not listed here. These are the ones whose message body is
// somebody's own words or somebody's record -- a reroute that quietly drops one
// starts republishing it, which is exactly how these came to be listed.
describe("IN_APP_ONLY_TYPES", () => {
  it.each([
    "ChatMessage",
    "MatchChatMessage",
    "PlayerSanctioned",
    "MatchImported",
  ])("keeps %s off the support webhook", (type) => {
    expect(NotificationsService.IN_APP_ONLY_TYPES.has(type)).toBe(true);
  });
});
