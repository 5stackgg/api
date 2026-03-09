import { Logger } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";

// Mock fetch globally
const mockFetch = jest.fn().mockResolvedValue({ ok: true });
global.fetch = mockFetch as any;

function createService() {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({ insert_notifications_one: { id: "n1" } }),
  };

  const config = {
    get: jest.fn().mockReturnValue({ webDomain: "https://5stack.test" }),
  };

  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const service = new NotificationsService(hasura as any, logger, config as any);

  return { service, hasura, logger };
}

describe("NotificationsService", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe("sendMatchStatusNotification - non-notifiable status", () => {
    it("skips statuses not in NOTIFIABLE_STATUSES", async () => {
      const { service, hasura } = createService();

      await service.sendMatchStatusNotification("m1", "PickingPlayers" as any, "Scheduled" as any);

      // Should not query for tournament brackets since status is not notifiable
      expect(hasura.query).not.toHaveBeenCalled();
    });
  });

  describe("sendMatchStatusNotification - standalone match", () => {
    it("notifies organizer and players for standalone match", async () => {
      const { service, hasura } = createService();

      // Query 1: tournament brackets - none found (standalone)
      hasura.query.mockResolvedValueOnce({ tournament_brackets: [] });
      // Query 2: match details with lineups
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: {
          organizer_steam_id: "org-1",
          lineup_1: {
            lineup_players: [{ steam_id: "player-1" }, { steam_id: "player-2" }],
          },
          lineup_2: {
            lineup_players: [{ steam_id: "player-3" }],
          },
        },
      });
      // Query 3: discord notification setting
      hasura.query.mockResolvedValueOnce({
        settings_by_pk: { value: "false" },
      });

      await service.sendMatchStatusNotification("m1", "Live", "WaitingForCheckIn" as any);

      // Should insert notifications: 3 players + organizer + 1 admin = multiple mutations
      // Organizer + 3 players = 4 unique steam_ids, plus 1 admin notification = 5 mutations
      expect(hasura.mutation).toHaveBeenCalled();
      const mutationCalls = hasura.mutation.mock.calls;
      // At least one for players/organizer + one for admin
      expect(mutationCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("returns early if match not found", async () => {
      const { service, hasura } = createService();

      hasura.query.mockResolvedValueOnce({ tournament_brackets: [] });
      hasura.query.mockResolvedValueOnce({ matches_by_pk: null });

      await service.sendMatchStatusNotification("m1", "Live", "Scheduled" as any);

      expect(hasura.mutation).not.toHaveBeenCalled();
    });
  });

  describe("sendMatchStatusNotification - tournament match", () => {
    it("notifies tournament organizers for tournament match", async () => {
      const { service, hasura } = createService();

      const tournament = {
        id: "t1",
        name: "Test Cup",
        organizer_steam_id: "org-1",
        organizers: [{ steam_id: "org-2" }],
        discord_notifications_enabled: false,
        discord_webhook: null,
        discord_role_id: null,
        discord_notify_Live: false,
      };

      hasura.query.mockResolvedValueOnce({
        tournament_brackets: [{ stage: { tournament } }],
      });
      // Discord setting query
      hasura.query.mockResolvedValueOnce({
        settings_by_pk: { value: "false" },
      });

      await service.sendMatchStatusNotification("m1", "Live", "Scheduled" as any);

      // Should notify org-1 + org-2 + admin = 3 mutations
      expect(hasura.mutation).toHaveBeenCalledTimes(3);
    });
  });

  describe("sendMatchStatusNotification - Discord webhook cascade", () => {
    it("uses tournament webhook when available", async () => {
      const { service, hasura } = createService();

      const tournament = {
        id: "t1",
        name: "Cup",
        organizer_steam_id: "org-1",
        organizers: [],
        discord_notifications_enabled: true,
        discord_webhook: "https://discord.com/api/webhooks/123/abc",
        discord_role_id: null,
        discord_notify_Live: true,
      };

      hasura.query.mockResolvedValueOnce({
        tournament_brackets: [{ stage: { tournament } }],
      });

      await service.sendMatchStatusNotification("m1", "Live", "Scheduled" as any);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/123/abc",
        expect.anything(),
      );
    });

    it("falls back to match webhook when no tournament webhook", async () => {
      const { service, hasura } = createService();

      hasura.query.mockResolvedValueOnce({ tournament_brackets: [] });
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: {
          organizer_steam_id: "org-1",
          lineup_1: { lineup_players: [] },
          lineup_2: { lineup_players: [] },
        },
      });
      // Should discord notify? yes
      hasura.query.mockResolvedValueOnce({ settings_by_pk: { value: "true" } });
      // Match webhook
      hasura.query.mockResolvedValueOnce({
        settings_by_pk: { value: "https://discord.com/api/webhooks/456/def" },
      });
      // Role ID
      hasura.query.mockResolvedValueOnce({ settings_by_pk: { value: null } });

      await service.sendMatchStatusNotification("m1", "Canceled", "Live");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/456/def",
        expect.anything(),
      );
    });

    it("skips Discord when webhook URL is invalid", async () => {
      const { service, hasura, logger } = createService();

      hasura.query.mockResolvedValueOnce({ tournament_brackets: [] });
      hasura.query.mockResolvedValueOnce({
        matches_by_pk: {
          organizer_steam_id: "org-1",
          lineup_1: { lineup_players: [] },
          lineup_2: { lineup_players: [] },
        },
      });
      // Should discord notify? yes
      hasura.query.mockResolvedValueOnce({ settings_by_pk: { value: "true" } });
      // Invalid webhook URL
      hasura.query.mockResolvedValueOnce({
        settings_by_pk: { value: "https://evil.com/webhook" },
      });

      await service.sendMatchStatusNotification("m1", "Canceled", "Live");

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid Discord webhook"),
      );
    });
  });

  describe("sendMatchStatusNotification - error handling", () => {
    it("logs error and does not throw", async () => {
      const { service, hasura, logger } = createService();

      hasura.query.mockRejectedValueOnce(new Error("Hasura down"));

      await expect(
        service.sendMatchStatusNotification("m1", "Live", "Scheduled" as any),
      ).resolves.not.toThrow();

      expect(logger.error).toHaveBeenCalled();
    });
  });
});
