import { DedicatedServersService } from "./dedicated-servers.service";

// Remove-then-create is not atomic. Two overlapping rebuilds of one server used
// to interleave: both removed, one created, and the other's AlreadyExists
// handler deleted the deployment the first had just created.
describe("DedicatedServersService.rebuildDedicatedServer", () => {
  const service = new DedicatedServersService(
    { log: jest.fn(), error: jest.fn(), verbose: jest.fn() } as never,
    { get: () => ({ namespace: "5stack" }) } as never,
    null as never,
    null as never,
    null as never,
    { getConnection: () => ({}) } as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  const steps: Array<string> = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  beforeEach(() => {
    steps.length = 0;

    jest
      .spyOn(service, "removeDedicatedServer")
      .mockImplementation(async (serverId: string) => {
        steps.push(`remove ${serverId}`);
        await tick();
      });
    jest
      .spyOn(service, "setupDedicatedServer")
      .mockImplementation(async (serverId: string) => {
        steps.push(`setup ${serverId}`);
        await tick();
        steps.push(`created ${serverId}`);
        return true;
      });
  });

  it("runs overlapping rebuilds of one server one after the other", async () => {
    await Promise.all([
      service.rebuildDedicatedServer("a"),
      service.rebuildDedicatedServer("a"),
    ]);

    expect(steps).toEqual([
      "remove a",
      "setup a",
      "created a",
      "remove a",
      "setup a",
      "created a",
    ]);
  });

  it("does not hold up a different server", async () => {
    await Promise.all([
      service.rebuildDedicatedServer("a"),
      service.rebuildDedicatedServer("b"),
    ]);

    expect(steps.slice(0, 2)).toEqual(["remove a", "remove b"]);
  });

  it("only removes when the server should not start", async () => {
    await service.rebuildDedicatedServer("a", false);

    expect(steps).toEqual(["remove a"]);
  });

  it("keeps going after a rebuild that failed", async () => {
    jest
      .spyOn(service, "setupDedicatedServer")
      .mockRejectedValueOnce(new Error("boom"));

    const [first, second] = await Promise.allSettled([
      service.rebuildDedicatedServer("a"),
      service.rebuildDedicatedServer("a"),
    ]);

    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: true });
  });
});

describe("DedicatedServersService.pluginInstallEnvironment", () => {
  const installs = (type: string, game = "cs2") =>
    Object.fromEntries(
      DedicatedServersService.pluginInstallEnvironment({ type, game }).map(
        ({ name, value }) => [name, value],
      ),
    );

  it("gives a Ranked server only the match plugin", () => {
    expect(installs("Ranked")).toEqual({
      INSTALL_5STACK_PLUGIN: "true",
      INSTALL_UTILITY_PRACTICE_PLUGIN: "false",
      INSTALL_PLAYER_MANAGEMENT_PLUGIN: "false",
    });
  });

  it("gives a Practice server only the utility plugin", () => {
    expect(installs("Practice")).toEqual({
      INSTALL_5STACK_PLUGIN: "false",
      INSTALL_UTILITY_PRACTICE_PLUGIN: "true",
      INSTALL_PLAYER_MANAGEMENT_PLUGIN: "false",
    });
  });

  it.each(["Competitive", "Casual", "Wingman", "Deathmatch", "Custom"])(
    "gives a %s community server the player management plugin",
    (type) => {
      expect(installs(type)).toEqual({
        INSTALL_5STACK_PLUGIN: "false",
        INSTALL_UTILITY_PRACTICE_PLUGIN: "false",
        INSTALL_PLAYER_MANAGEMENT_PLUGIN: "true",
      });
    },
  );

  it("never gives a CS:GO server the CS2-only player management plugin", () => {
    expect(installs("Casual", "csgo").INSTALL_PLAYER_MANAGEMENT_PLUGIN).toBe(
      "false",
    );
  });
});
