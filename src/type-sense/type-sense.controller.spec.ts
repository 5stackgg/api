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

describe("TypeSenseController player_events", () => {
  it("caches the player's name as it is now, not as a late event had it", async () => {
    const cache = { forget: jest.fn(), put: jest.fn() };
    const hasura = {
      query: jest.fn().mockResolvedValue({ players_by_pk: { name: "Carol" } }),
    };

    await new TypeSenseController(
      cache as any,
      hasura as any,
      { updatePlayer: jest.fn() } as any,
      {} as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { add: jest.fn(), remove: jest.fn() } as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    ).player_events({
      op: "UPDATE",
      old: { steam_id: "76561198000000001", name: "Alice" },
      new: { steam_id: "76561198000000001", name: "Bob" },
    } as any);

    expect(cache.put).toHaveBeenCalledWith(expect.any(String), "Carol");
    expect(cache.put).not.toHaveBeenCalledWith(expect.any(String), "Bob");
  });

  const STEAM_ID = "76561198000000001";

  const failingForget = () => {
    const typeSense = { updatePlayer: jest.fn(), removePlayer: jest.fn() };
    const controller = new TypeSenseController(
      { forget: jest.fn().mockResolvedValue(false), put: jest.fn() } as any,
      { query: jest.fn() } as any,
      typeSense as any,
      {} as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { add: jest.fn(), remove: jest.fn() } as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, typeSense };
  };

  // The hook hands out the cached role for up to an hour, and every reconnect
  // of a staff socket asks it again.
  it.each([
    [
      "a role change",
      {
        op: "UPDATE",
        old: { steam_id: STEAM_ID, role: "administrator" },
        new: { steam_id: STEAM_ID, role: "user" },
      },
    ],
    [
      "a deleted player",
      { op: "DELETE", old: { steam_id: STEAM_ID, role: "moderator" }, new: {} },
    ],
  ])(
    "fails %s whose cached role it could not forget, so Hasura retries it",
    async (_label, event) => {
      const { controller, typeSense } = failingForget();

      await expect(controller.player_events(event as any)).rejects.toThrow(
        /cached role/,
      );
      expect(typeSense.updatePlayer).not.toHaveBeenCalled();
      expect(typeSense.removePlayer).not.toHaveBeenCalled();
    },
  );

  it("does not fail an update that left the role alone", async () => {
    const { controller, typeSense } = failingForget();

    await controller.player_events({
      op: "UPDATE",
      old: { steam_id: STEAM_ID, role: "user", country: "US" },
      new: { steam_id: STEAM_ID, role: "user", country: "CA" },
    } as any);

    expect(typeSense.updatePlayer).toHaveBeenCalledWith(STEAM_ID);
  });
});
