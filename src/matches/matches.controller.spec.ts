jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchesController } from "./matches.controller";

describe("MatchesController", () => {
  let controller: MatchesController;
  let matchAssistant: {
    isOrganizer: jest.Mock;
    rebootOnDemandServer: jest.Mock;
  };
  let hasura: { query: jest.Mock };
  let notifications: { send: jest.Mock };

  beforeEach(() => {
    matchAssistant = {
      isOrganizer: jest.fn(),
      rebootOnDemandServer: jest.fn(),
    };
    hasura = { query: jest.fn() };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };

    controller = new MatchesController(
      {} as any,
      hasura as any,
      {} as any,
      {
        get: jest.fn(() => ({ webDomain: "https://5stack.test" })),
      } as any,
      {} as any,
      matchAssistant as any,
      {} as any,
      {} as any,
      {} as any,
      notifications as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it("rejects non-organizers", async () => {
    matchAssistant.isOrganizer.mockResolvedValue(false);

    await expect(
      controller.rebootMatchServer({
        match_id: "match-1",
        user: { steam_id: "user-1" } as any,
      }),
    ).rejects.toThrow("you are not a match organizer");

    expect(matchAssistant.rebootOnDemandServer).not.toHaveBeenCalled();
  });

  it("initiates a reboot for organizers", async () => {
    matchAssistant.isOrganizer.mockResolvedValue(true);
    matchAssistant.rebootOnDemandServer.mockResolvedValue(undefined);

    await expect(
      controller.rebootMatchServer({
        match_id: "match-1",
        user: { steam_id: "user-1" } as any,
      }),
    ).resolves.toEqual({ success: true });

    expect(matchAssistant.rebootOnDemandServer).toHaveBeenCalledWith("match-1");
  });

  describe("callForOrganizer", () => {
    const matchId = "00000000-0000-0000-0000-000000000001";

    const callForOrganizer = (user: Record<string, unknown>) =>
      controller.callForOrganizer({
        match_id: matchId,
        user: { steam_id: "76561198000000001", ...user } as any,
      });

    const sent = () => {
      const [type, notification] = notifications.send.mock.calls[0];
      return { type, ...notification };
    };

    beforeEach(() => {
      hasura.query.mockResolvedValue({
        matches_by_pk: { is_in_lineup: true, requested_organizer: false },
      });
    });

    it("names the requester without linking them", async () => {
      await callForOrganizer({ name: "<b>keith</b>" });

      const notification = sent();
      expect(notification.type).toBe("MatchSupport");
      expect(notification.message).toContain(
        "<b>&lt;b&gt;keith&lt;/b&gt;</b> requested assistance in match",
      );
      expect(notification.message.match(/href="([^"]+)"/)?.[1]).toBe(
        `https://5stack.test/matches/${matchId}`,
      );
    });

    it("falls back to the steam id when the requester has no name", async () => {
      await callForOrganizer({ name: undefined });

      expect(sent().message).toContain(
        "<b>76561198000000001</b> requested assistance",
      );
    });

    it("titles the notification without the old typo", async () => {
      await callForOrganizer({ name: "keith" });

      expect(sent().title).toBe("Match Assistance Required");
      expect(sent().message).not.toContain("Assistanced");
    });

    it("rejects someone who is not playing in the match", async () => {
      hasura.query.mockResolvedValue({
        matches_by_pk: { is_in_lineup: false, requested_organizer: false },
      });

      await expect(callForOrganizer({ name: "keith" })).rejects.toThrow(
        "only players in this match can contact support",
      );
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it("does not ask twice while a request is still open", async () => {
      hasura.query.mockResolvedValue({
        matches_by_pk: { is_in_lineup: true, requested_organizer: true },
      });

      await expect(callForOrganizer({ name: "keith" })).resolves.toEqual({
        success: true,
      });
      expect(notifications.send).not.toHaveBeenCalled();
    });
  });
});
