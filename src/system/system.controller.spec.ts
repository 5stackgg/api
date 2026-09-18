import { SystemController } from "./system.controller";

// Name registration is the one place a player writes their own display name
// without an admin in the loop, so the guards around it are what keep the
// approval flow from being optional.
describe("SystemController names", () => {
  let controller: SystemController;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifications: { send: jest.Mock; notifyPlayers: jest.Mock };
  let player: { name: string; name_registered: boolean } | null;

  const user = (steamId: string, role: string | null = "user") =>
    ({ steam_id: steamId, role }) as any;

  beforeEach(() => {
    player = { name: "current", name_registered: false };

    hasura = {
      query: jest.fn(async (payload: any) => {
        if (payload.players_by_pk) {
          return { players_by_pk: player };
        }
        return { notifications: [] as Array<unknown> };
      }),
      mutation: jest.fn(async () => ({})),
    };

    notifications = { send: jest.fn(), notifyPlayers: jest.fn() };

    controller = new SystemController(
      {} as any,
      hasura as any,
      notifications as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  function registeredName() {
    const call = hasura.mutation.mock.calls.find(
      ([payload]: [any]) => payload.update_players_by_pk,
    );
    return call?.[0].update_players_by_pk.__args._set.name;
  }

  describe("registerName", () => {
    it("registers a name for a player who has not registered one", async () => {
      await controller.registerName({ user: user("1"), name: "keith" });

      expect(registeredName()).toBe("keith");
      expect(
        hasura.mutation.mock.calls[0][0].update_players_by_pk.__args._set
          .name_registered,
      ).toBe(true);
    });

    it("refuses to re-register a name that is already registered", async () => {
      player = { name: "current", name_registered: true };

      // registerName skips the admin approval that requestNameChange requires,
      // so a second call would be a self-serve rename
      await expect(
        controller.registerName({ user: user("1"), name: "somebody-else" }),
      ).rejects.toThrow();

      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    it("rejects a blank name", async () => {
      await expect(
        controller.registerName({ user: user("1"), name: "   " }),
      ).rejects.toThrow();

      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    it("rejects a name that is too short or too long", async () => {
      await expect(
        controller.registerName({ user: user("1"), name: "ab" }),
      ).rejects.toThrow();

      await expect(
        controller.registerName({ user: user("1"), name: "a".repeat(33) }),
      ).rejects.toThrow();

      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    it("stores the trimmed name", async () => {
      await controller.registerName({ user: user("1"), name: "  keith  " });

      expect(registeredName()).toBe("keith");
    });
  });

  describe("requestNameChange", () => {
    it("files the request against the player who asked for it", async () => {
      await controller.requestNameChange({
        user: user("76561198000000001"),
        steam_id: "76561198000000001",
        name: "new name",
      } as any);

      expect(notifications.send).toHaveBeenCalled();
      const [, notification] = notifications.send.mock.calls[0];
      expect(notification.entity_id).toBe("76561198000000001");
    });

    it("ignores a steam id the caller does not own", async () => {
      // the action takes steam_id from the client, so without this a player can
      // file a rename for somebody else and have an admin approve it
      await controller.requestNameChange({
        user: user("76561198000000001"),
        steam_id: "76561198000000002",
        name: "new name",
      } as any);

      const [, notification] = notifications.send.mock.calls[0];
      expect(notification.entity_id).toBe("76561198000000001");
    });

    it("lets an administrator file a request for another player", async () => {
      await controller.requestNameChange({
        user: user("76561198000000001", "administrator"),
        steam_id: "76561198000000002",
        name: "new name",
      } as any);

      const [, notification] = notifications.send.mock.calls[0];
      expect(notification.entity_id).toBe("76561198000000002");
    });

    it("rejects a blank name", async () => {
      await expect(
        controller.requestNameChange({
          user: user("76561198000000001"),
          steam_id: "76561198000000001",
          name: "  ",
        } as any),
      ).rejects.toThrow();

      expect(notifications.send).not.toHaveBeenCalled();
    });
  });
});
