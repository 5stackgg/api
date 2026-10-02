import { TypeSenseController } from "./type-sense.controller";

describe("TypeSenseController player_sanctions", () => {
  const BANNED = "76561198000000001";

  const controller = (notifications: {
    queueSanctionNotification: jest.Mock;
  }) =>
    new TypeSenseController(
      {} as any,
      {
        query: jest.fn().mockResolvedValue({ match_lineup_players: [] }),
      } as any,
      { updatePlayer: jest.fn() } as any,
      notifications as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { add: jest.fn(), remove: jest.fn() } as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    );

  // There is no per-ban opt-in: whoever issued the ban, and whether anyone did,
  // the co-player notice goes out and each player's own preference decides.
  it.each([
    ["an automatic Steam ban", null, "VAC ban on record (1 ban)"],
    ["a moderator's ban", "76561198000000009", "cheating"],
  ])("queues the co-player notice for %s", async (_label, by, reason) => {
    const notifications = {
      queueSanctionNotification: jest.fn().mockResolvedValue(undefined),
    };

    await controller(notifications).player_sanctions({
      op: "INSERT",
      old: null,
      new: {
        id: "sanction-1",
        player_steam_id: BANNED,
        sanctioned_by_steam_id: by,
        type: "ban",
        reason,
        remove_sanction_date: null,
      },
    } as any);

    expect(notifications.queueSanctionNotification).toHaveBeenCalledWith({
      sanctionId: "sanction-1",
      steamId: BANNED,
      type: "ban",
      reason,
    });
  });
});
