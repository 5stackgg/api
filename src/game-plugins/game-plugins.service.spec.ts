import { GamePluginsService } from "./game-plugins.service";

// The registry build picks the Linux asset out of a release; a plugin added by
// hand has to make the same choice, or the operator installs a Windows build
// that unpacks perfectly and then never loads.
describe("GamePluginsService.selectReleaseAsset", () => {
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://github.com/o/r/releases/download/v1/${name}`,
  });

  it("takes the only archive on offer", () => {
    expect(
      GamePluginsService.selectReleaseAsset([asset("Plugin-v1.0.0.zip")])?.name,
    ).toEqual("Plugin-v1.0.0.zip");
  });

  it("prefers the asset that names linux", () => {
    expect(
      GamePluginsService.selectReleaseAsset([
        asset("Plugin-windows.zip"),
        asset("Plugin-linux.zip"),
      ])?.name,
    ).toEqual("Plugin-linux.zip");
  });

  it("refuses a release that only ships builds for another platform", () => {
    expect(
      GamePluginsService.selectReleaseAsset([
        asset("Plugin-win64.zip"),
        asset("Plugin-macos.zip"),
      ]),
    ).toBeNull();
  });

  it("ignores anything that is not an archive", () => {
    expect(
      GamePluginsService.selectReleaseAsset([
        asset("checksums.txt"),
        asset("Plugin.pdb"),
      ]),
    ).toBeNull();
  });

  // "darwin" as a substring of a real name is not a platform tag.
  it("does not mistake a substring for a platform", () => {
    expect(
      GamePluginsService.selectReleaseAsset([asset("darwinism-v2.zip")])?.name,
    ).toEqual("darwinism-v2.zip");
  });
});

describe("GamePluginsService.slugFrom", () => {
  it("makes a slug out of a repository name", () => {
    expect(GamePluginsService.slugFrom("cs2-ss2-inventory-simulator")).toEqual(
      "cs2-ss2-inventory-simulator",
    );
  });

  it("normalises punctuation and case", () => {
    expect(GamePluginsService.slugFrom("MatchZy_Plugin")).toEqual(
      "matchzy-plugin",
    );
  });

  // The version in an asset filename is not part of the plugin's identity;
  // leaving it in would make every release a different plugin.
  it("drops a trailing version", () => {
    expect(GamePluginsService.slugFrom("Retakes-1.2.0")).toEqual("retakes");
  });

  it("drops a v-prefixed version too", () => {
    expect(
      GamePluginsService.slugFrom("InventorySimulator-v1.2.0.zip"),
    ).toEqual("inventorysimulator");
  });

  // A digit that is part of the name, not a release number.
  it("keeps a version-looking name that is the name", () => {
    expect(GamePluginsService.slugFrom("cs2-ss2-inventory-simulator")).toEqual(
      "cs2-ss2-inventory-simulator",
    );
  });

  it("gives up rather than inventing a slug", () => {
    expect(GamePluginsService.slugFrom("...")).toBeUndefined();
  });
});

// An auto update is the one version change nobody asked for, so the decision
// to raise a notice is made here rather than left to whoever reads the panel.
describe("GamePluginsService update notices", () => {
  let postgres: { query: jest.Mock };
  let queue: { add: jest.Mock };
  let pluginRuntime: { getPluginRuntime: jest.Mock };
  let service: GamePluginsService;

  const report = (progress: Record<string, any>) =>
    service.recordNodeProgress("node-1", progress as any);

  const queued = () => queue.add.mock.calls[0]?.[1];
  const options = () => queue.add.mock.calls[0]?.[2];

  beforeEach(() => {
    postgres = { query: jest.fn(async (): Promise<Array<any>> => []) };
    queue = { add: jest.fn(async (): Promise<void> => undefined) };
    pluginRuntime = { getPluginRuntime: jest.fn(async (): Promise<string> => "swiftlys2") };

    service = new GamePluginsService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      postgres as any,
      pluginRuntime as any,
      {} as any,
      queue as any,
    );
  });

  it("raises a notice when a plugin replaced a different version", async () => {
    await report({
      slug: "retakes",
      status: "Installed",
      version: "1.2.0",
      previousVersion: "1.1.0",
    });

    expect(queued()).toEqual(
      expect.objectContaining({ outcome: "updated", previousVersion: "1.1.0" }),
    );
  });

  it("says nothing about a first install", async () => {
    await report({
      slug: "retakes",
      status: "Installed",
      version: "1.2.0",
      previousVersion: null,
    });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("says nothing when the version did not move", async () => {
    await report({
      slug: "retakes",
      status: "Installed",
      version: "1.2.0",
      previousVersion: "1.2.0",
    });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("raises a notice when an install failed", async () => {
    await report({
      slug: "retakes",
      status: "Failed",
      version: "1.2.0",
      previousVersion: "1.1.0",
      error: "digest mismatch",
    });

    expect(queued()).toEqual(expect.objectContaining({ outcome: "failed" }));
  });

  // The whole fleet reports the same release, and a failing install is retried
  // every five minutes forever. Without one id per release that is a
  // notification every five minutes per node.
  it("keys the notice to the release rather than the node", async () => {
    await report({
      slug: "retakes",
      status: "Installed",
      version: "1.2.0",
      previousVersion: "1.1.0",
    });

    expect(options().jobId).toEqual("plugin-updated.retakes.1.2.0");
  });

  it("records the progress even when the notice cannot be queued", async () => {
    queue.add.mockRejectedValue(new Error("redis is down"));

    await expect(
      report({
        slug: "retakes",
        status: "Installed",
        version: "1.2.0",
        previousVersion: "1.1.0",
      }),
    ).resolves.toBeUndefined();

    expect(postgres.query).toHaveBeenCalled();
  });
});

// Turning auto updates off has to mean "stay where you are". Pinning to the
// newest published build would roll the fleet forward on the way to freezing
// it.
describe("GamePluginsService.setAutoUpdate", () => {
  let postgres: { query: jest.Mock };
  let service: GamePluginsService;

  const build = () => {
    postgres = { query: jest.fn(async (): Promise<Array<any>> => []) };

    service = new GamePluginsService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      postgres as any,
      { getPluginRuntime: jest.fn(async (): Promise<string> => "swiftlys2") } as any,
      {} as any,
      { add: jest.fn() } as any,
    );
  };

  const update = () =>
    postgres.query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE public.game_plugin_installs"),
    );

  it("pins to the version the nodes are actually running", async () => {
    build();
    postgres.query
      .mockResolvedValueOnce([{ channel: "Auto" }])
      .mockResolvedValueOnce([{ version: "1.1.0" }])
      .mockResolvedValue([]);

    await service.setAutoUpdate("retakes", false);

    expect(update()[1]).toEqual(["retakes", "1.1.0"]);
  });

  it("clears the pin when it is turned back on", async () => {
    build();
    postgres.query.mockResolvedValueOnce([{ channel: "Pinned" }]);

    await service.setAutoUpdate("retakes", true);

    expect(update()[0]).toContain("'Auto'");
  });

  it("refuses a plugin that is not installed", async () => {
    build();

    await expect(service.setAutoUpdate("retakes", false)).rejects.toThrow(
      "not installed",
    );
  });
});
