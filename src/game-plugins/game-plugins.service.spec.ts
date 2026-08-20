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
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let service: GamePluginsService;

  const report = (progress: Record<string, any>) =>
    service.recordNodeProgress("node-1", progress as any);

  const queued = () => queue.add.mock.calls[0]?.[1];
  const options = () => queue.add.mock.calls[0]?.[2];

  const installed = (channel = "Auto") => {
    postgres.query.mockImplementation(async (sql: string) =>
      sql.includes("FROM public.game_plugin_installs i")
        ? [{ name: "Retakes", channel }]
        : [],
    );
  };

  beforeEach(() => {
    postgres = { query: jest.fn(async (): Promise<Array<any>> => []) };
    queue = {
      add: jest.fn(async (): Promise<void> => undefined),
      getJob: jest.fn(async (): Promise<any> => null),
    };

    service = new GamePluginsService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      postgres as any,
      {
        getPluginRuntime: jest.fn(async (): Promise<string> => "swiftlys2"),
      } as any,
      {} as any,
      queue as any,
    );

    installed();
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

    expect(queued()).toEqual(
      expect.objectContaining({ outcome: "failed", error: "digest mismatch" }),
    );
  });

  // Deciding this inside the job would complete the job, and a completed job
  // holds its id for the whole dedup window -- suppressing the notice for that
  // release for a week rather than just this once.
  it("decides against a pinned plugin before booking the id", async () => {
    installed("Pinned");

    await report({
      slug: "retakes",
      status: "Installed",
      version: "1.2.0",
      previousVersion: "1.1.0",
    });

    expect(queue.add).not.toHaveBeenCalled();
  });

  // A pinned install failing is exactly as silent as an auto one.
  it("still reports a pinned install failing", async () => {
    installed("Pinned");

    await report({
      slug: "retakes",
      status: "Failed",
      version: "1.2.0",
      error: "404",
    });

    expect(queued()).toEqual(expect.objectContaining({ outcome: "failed" }));
  });

  it("books nothing for a plugin that is no longer installed", async () => {
    postgres.query.mockResolvedValue([]);

    await report({
      slug: "retakes",
      status: "Installed",
      version: "1.2.0",
      previousVersion: "1.1.0",
    });

    expect(queue.add).not.toHaveBeenCalled();
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

  // Otherwise one notice names whichever node happened to report first and the
  // rest of the fleet is silently dropped from it.
  it("adds later nodes to the notice already waiting", async () => {
    const booked = {
      data: { nodes: ["node-1"] },
      updateData: jest.fn(async (): Promise<void> => undefined),
    };
    queue.getJob.mockResolvedValue(booked);

    await service.recordNodeProgress("node-2", {
      slug: "retakes",
      status: "Failed",
      version: "1.2.0",
      error: "digest mismatch",
    } as any);

    expect(booked.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: ["node-1", "node-2"] }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not list the same node twice", async () => {
    const booked = {
      data: { nodes: ["node-1"] },
      updateData: jest.fn(async (): Promise<void> => undefined),
    };
    queue.getJob.mockResolvedValue(booked);

    await report({
      slug: "retakes",
      status: "Failed",
      version: "1.2.0",
      error: "digest mismatch",
    });

    expect(booked.updateData).not.toHaveBeenCalled();
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

  // A connector that predates the previousVersion field still says what it is
  // installing, and the row still holds what it is replacing.
  it("reads the replaced version off the row for an older connector", async () => {
    postgres.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version, previous_version FROM")) {
        return [{ version: "1.1.0" }];
      }
      return sql.includes("FROM public.game_plugin_installs i")
        ? [{ name: "Retakes", channel: "Auto" }]
        : [];
    });

    await report({ slug: "retakes", status: "Installing", version: "1.2.0" });

    const write = postgres.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO public.game_server_node_plugins"),
    );

    expect(write[1]).toContain("1.1.0");
  });
});

// Turning auto updates off has to mean "stay where you are". Pinning to the
// newest published build would roll the fleet forward on the way to freezing
// it.
describe("GamePluginsService.setAutoUpdate", () => {
  let postgres: { query: jest.Mock };
  let responses: Record<string, Array<any>>;
  let service: GamePluginsService;

  // Order matters: the pin candidate query unnests its runtimes, so it also
  // mentions "runtime" and would otherwise answer as the runtime lookup.
  const match = (sql: string) => {
    if (sql.includes("FROM public.game_server_node_plugins p")) {
      return "running";
    }
    if (sql.includes("DISTINCT COALESCE(pin_plugin_runtime")) {
      return "runtimes";
    }
    if (sql.includes("SELECT channel FROM public.game_plugin_installs")) {
      return "install";
    }
    if (sql.includes("FROM public.game_plugin_versions v")) {
      return "publishable";
    }
    return "other";
  };

  beforeEach(() => {
    responses = {
      install: [{ channel: "Auto" }],
      runtimes: [{ runtime: "swiftlys2" }],
      running: [{ version: "1.1.0" }],
      publishable: [],
      other: [],
    };

    postgres = {
      query: jest.fn(async (sql: string): Promise<Array<any>> => {
        return responses[match(sql)] ?? [];
      }),
    };

    service = new GamePluginsService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      postgres as any,
      {
        getPluginRuntime: jest.fn(async (): Promise<string> => "swiftlys2"),
      } as any,
      {} as any,
      { add: jest.fn(), getJob: jest.fn() } as any,
    );
  });

  const update = () =>
    postgres.query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE public.game_plugin_installs"),
    );

  it("pins to the version the nodes are actually running", async () => {
    await service.setAutoUpdate("retakes", false);

    expect(update()[1]).toEqual(["retakes", "1.1.0"]);
  });

  it("clears the pin when it is turned back on", async () => {
    await service.setAutoUpdate("retakes", true);

    expect(update()[0]).toContain("'Auto'");
  });

  it("refuses a plugin that is not installed", async () => {
    responses.install = [];

    await expect(service.setAutoUpdate("retakes", false)).rejects.toThrow(
      "not installed",
    );
  });

  // Pinning to a version one runtime never published makes desiredForNode drop
  // the plugin for those nodes, and converge() uninstalls whatever it is not
  // sent -- so the wrong pin does not leave a node behind, it wipes the plugin
  // off it.
  it("refuses when no version covers every runtime in play", async () => {
    responses.running = [];
    responses.publishable = [];
    responses.runtimes = [
      { runtime: "swiftlys2" },
      { runtime: "counterstrikesharp" },
    ];

    await expect(service.setAutoUpdate("retakes", false)).rejects.toThrow(
      "every runtime in use",
    );
  });

  it("falls back to a release every runtime can install", async () => {
    responses.running = [];
    responses.publishable = [{ version: "1.0.0" }];

    await service.setAutoUpdate("retakes", false);

    expect(update()[1]).toEqual(["retakes", "1.0.0"]);
  });

  // Pinning down to an older build is as much a change to converge to as
  // rolling forward, and without the nudge the toggle looks dead for the five
  // minutes until the next poll.
  it("nudges the fleet in both directions", async () => {
    await service.setAutoUpdate("retakes", false);

    expect(
      postgres.query.mock.calls.some(([sql]) =>
        sql.includes("FROM public.game_server_nodes\n          WHERE enabled"),
      ),
    ).toBe(true);
  });
});
