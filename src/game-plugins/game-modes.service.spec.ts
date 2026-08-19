import { GameModesService, RequiredPluginMissing } from "./game-modes.service";

// always_load shipped broken: the merge lived in environmentFor(), which nothing
// called, so a plugin marked "load on every match" never reached a server.
// These pin the merge to resolveForServer, which is what the pod specs use.
describe("GameModesService always-load plugins", () => {
  const build = (rows: Record<string, Array<Record<string, unknown>>>) => {
    const postgres = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("COALESCE(")) {
          return rows.serverMode ?? [{ game_mode_id: null }];
        }
        if (sql.includes("FROM game_modes")) {
          return rows.mode ?? [];
        }
        if (sql.includes("FROM game_mode_plugins")) {
          return rows.modePlugins ?? [];
        }
        if (sql.includes("AS disable")) {
          return rows.guidelines ?? [{ disable: false }];
        }
        if (sql.includes("FROM game_plugin_installs")) {
          return rows.alwaysLoad ?? [];
        }
        return [];
      }),
    };

    const service = new GameModesService(
      { warn: jest.fn(), log: jest.fn() } as never,
      postgres as never,
      {
        getPluginRuntime: jest.fn(async () => "swiftlys2"),
        resolvePluginRuntime: jest.fn(
          async (pin?: { pin_plugin_runtime?: string | null }) =>
            pin?.pin_plugin_runtime ?? "swiftlys2",
        ),
      } as never,
    );

    return { service, postgres };
  };

  it("loads an always-load plugin on a server with no mode at all", async () => {
    const { service } = build({
      serverMode: [{ game_mode_id: null }],
      alwaysLoad: [{ plugin_slug: "stats", version: "1.0.0" }],
    });

    const resolved = await service.resolveForServer("server-1");

    expect(resolved?.enabledPlugins).toEqual("stats@1.0.0");
    // No mode, so nothing a mode would have contributed comes along with it.
    expect(resolved?.cfg).toBeNull();
    expect(resolved?.extraGameParams).toBeNull();
  });

  it("returns nothing when there is neither a mode nor an always-load plugin", async () => {
    const { service } = build({ serverMode: [{ game_mode_id: null }] });

    await expect(service.resolveForServer("server-1")).resolves.toBeNull();
  });

  it("appends always-load plugins to a mode's own set", async () => {
    const { service } = build({
      serverMode: [{ game_mode_id: "mode-1" }],
      mode: [
        {
          id: "mode-1",
          slug: "retakes",
          name: "Retakes",
          cfg: "mp_freezetime 3",
          extra_game_params: null,
        },
      ],
      modePlugins: [
        {
          plugin_slug: "retakes",
          config: null,
          config_path: null,
          version: "2.0.0",
        },
      ],
      alwaysLoad: [{ plugin_slug: "stats", version: "1.0.0" }],
    });

    const resolved = await service.resolveForServer("server-1");

    expect(resolved?.enabledPlugins).toEqual("retakes@2.0.0,stats@1.0.0");
    expect(resolved?.cfg).toEqual("mp_freezetime 3");
  });

  it("lets the mode's version win when both name the same plugin", async () => {
    const { service } = build({
      serverMode: [{ game_mode_id: "mode-1" }],
      mode: [
        {
          id: "mode-1",
          slug: "m",
          name: "M",
          cfg: null,
          extra_game_params: null,
        },
      ],
      modePlugins: [
        {
          plugin_slug: "stats",
          config: null,
          config_path: null,
          version: "2.0.0",
        },
      ],
      alwaysLoad: [{ plugin_slug: "stats", version: "1.0.0" }],
    });

    const resolved = await service.resolveForServer("server-1");

    expect(resolved?.enabledPlugins).toEqual("stats@2.0.0");
  });

  it("skips an always-load plugin no node has installed", async () => {
    const { service } = build({
      serverMode: [{ game_mode_id: null }],
      alwaysLoad: [{ plugin_slug: "stats", version: null }],
    });

    await expect(service.resolveForServer("server-1")).resolves.toBeNull();
  });

  it("preview merges always-load plugins, which is the whole point of it", async () => {
    const { service } = build({
      mode: [
        {
          id: "mode-1",
          slug: "retakes",
          name: "Retakes",
          cfg: null,
          extra_game_params: null,
        },
      ],
      modePlugins: [
        {
          plugin_slug: "retakes",
          config: null,
          config_path: null,
          version: "2.0.0",
        },
      ],
      alwaysLoad: [{ plugin_slug: "stats", version: "1.0.0" }],
    });

    const preview = await service.previewForMode("mode-1");

    expect(preview?.enabledPlugins).toEqual("retakes@2.0.0,stats@1.0.0");
  });
});

// link_plugins gates a plugin's files on slug@version being on the node's own
// disk, so naming a version a different node happens to have loads nothing.
describe("GameModesService node scoping", () => {
  const build = (
    server: Record<string, unknown>,
    plugins: Array<Record<string, unknown>>,
  ) => {
    const seen: Array<{ sql: string; params: Array<unknown> }> = [];

    const postgres = {
      query: jest.fn(async (sql: string, params: Array<unknown> = []) => {
        seen.push({ sql, params });

        if (sql.includes("COALESCE(")) {
          return [server];
        }
        if (sql.includes("FROM game_modes")) {
          return [
            {
              id: "mode-1",
              slug: "retakes",
              name: "Retakes",
              cfg: null,
              extra_game_params: null,
            },
          ];
        }
        if (sql.includes("AS disable")) {
          return [{ disable: false }];
        }
        if (sql.includes("FROM game_mode_plugins")) {
          const nodeId = params[2];

          return plugins.map((plugin) => ({
            ...plugin,
            version:
              (plugin.versionsByNode as Record<string, string>)[
                nodeId as string
              ] ?? null,
          }));
        }
        return [];
      }),
    };

    const service = new GameModesService(
      { warn: jest.fn(), log: jest.fn() } as never,
      postgres as never,
      {
        getPluginRuntime: jest.fn(async () => "swiftlys2"),
        resolvePluginRuntime: jest.fn(
          async (pin?: { pin_plugin_runtime?: string | null }) =>
            pin?.pin_plugin_runtime ?? "swiftlys2",
        ),
      } as never,
    );

    return { service, seen };
  };

  it("takes the version from the node hosting the server, not the newest reporter", async () => {
    const { service } = build(
      {
        game_mode_id: "mode-1",
        game_server_node_id: "node-a",
        pin_plugin_runtime: null,
      },
      [
        {
          plugin_slug: "retakes",
          config: null,
          config_path: null,
          required: true,
          versionsByNode: { "node-a": "1.0.0", "node-b": "1.1.0" },
        },
      ],
    );

    const resolved = await service.resolveForServer("server-1");

    expect(resolved?.enabledPlugins).toEqual("retakes@1.0.0");
  });

  it("asks for the node's pinned runtime rather than the deployment's", async () => {
    const { service, seen } = build(
      {
        game_mode_id: "mode-1",
        game_server_node_id: "node-a",
        pin_plugin_runtime: "counterstrikesharp",
      },
      [
        {
          plugin_slug: "retakes",
          config: null,
          config_path: null,
          required: true,
          versionsByNode: { "node-a": "1.0.0" },
        },
      ],
    );

    await service.resolveForServer("server-1");

    const modePlugins = seen.find((entry) =>
      entry.sql.includes("FROM game_mode_plugins"),
    );

    expect(modePlugins?.params[1]).toEqual("counterstrikesharp");
  });

  it("refuses to boot a mode whose required plugin is not on the node", async () => {
    const { service } = build(
      {
        game_mode_id: "mode-1",
        game_server_node_id: "node-a",
        pin_plugin_runtime: null,
      },
      [
        {
          plugin_slug: "retakes",
          config: null,
          config_path: null,
          required: true,
          versionsByNode: { "node-b": "1.1.0" },
        },
      ],
    );

    await expect(service.resolveForServer("server-1")).rejects.toBeInstanceOf(
      RequiredPluginMissing,
    );
  });

  it("boots without a plugin the mode marks optional", async () => {
    const { service } = build(
      {
        game_mode_id: "mode-1",
        game_server_node_id: "node-a",
        pin_plugin_runtime: null,
      },
      [
        {
          plugin_slug: "retakes",
          config: null,
          config_path: null,
          required: true,
          versionsByNode: { "node-a": "1.0.0" },
        },
        {
          plugin_slug: "stats",
          config: null,
          config_path: null,
          required: false,
          versionsByNode: {},
        },
      ],
    );

    const resolved = await service.resolveForServer("server-1");

    expect(resolved?.enabledPlugins).toEqual("retakes@1.0.0");
  });
});

// FollowCS2ServerGuidelines is true in both frameworks' shipped config, and
// turning it off is what Valve says can ban every GSLT on the account -- so it
// takes the catalog saying the plugin needs it AND the operator saying yes.
describe("GameModesService server guidelines", () => {
  const build = (rows: Record<string, Array<Record<string, unknown>>>) => {
    const seen: Array<{ sql: string; params: Array<unknown> }> = [];

    const postgres = {
      query: jest.fn(async (sql: string, params: Array<unknown> = []) => {
        seen.push({ sql, params });

        if (sql.includes("COALESCE(")) {
          return [{ game_mode_id: "mode-1", game_server_node_id: "node-a" }];
        }
        if (sql.includes("FROM game_modes")) {
          return [
            {
              id: "mode-1",
              slug: "skins",
              name: "Skins",
              cfg: null,
              extra_game_params: null,
            },
          ];
        }
        if (sql.includes("AS disable")) {
          return rows.guidelines ?? [{ disable: false }];
        }
        if (sql.includes("FROM game_mode_plugins")) {
          return rows.modePlugins ?? [];
        }
        if (sql.includes("FROM game_plugin_installs")) {
          return rows.alwaysLoad ?? [];
        }
        return [];
      }),
    };

    const service = new GameModesService(
      { warn: jest.fn(), log: jest.fn() } as never,
      postgres as never,
      {
        getPluginRuntime: jest.fn(async () => "swiftlys2"),
        resolvePluginRuntime: jest.fn(async () => "swiftlys2"),
      } as never,
    );

    return { service, seen };
  };

  const modePlugins: Array<Record<string, unknown>> = [
    {
      plugin_slug: "inventory-simulator",
      config: null,
      config_path: null,
      required: true,
      version: "1.0.0",
    },
  ];

  it("leaves the guidelines alone when nothing loading needs them off", async () => {
    const { service } = build({ modePlugins });

    const resolved = await service.resolveForServer("server-1");

    expect(resolved?.disableServerGuidelines).toBe(false);
    expect(service.environmentFor(resolved).map((env) => env.name)).toEqual([
      "ENABLED_PLUGINS",
    ]);
  });

  it("turns them off once the plugin needs it and the operator has agreed", async () => {
    const { service } = build({ modePlugins, guidelines: [{ disable: true }] });

    const resolved = await service.resolveForServer("server-1");

    expect(resolved?.disableServerGuidelines).toBe(true);
    expect(service.environmentFor(resolved)).toContainEqual({
      name: "DISABLE_SERVER_GUIDELINES",
      value: "true",
    });
  });

  // A plugin the operator opted in for, on a server whose mode does not select
  // it, is not a reason to boot that server non-compliant.
  it("asks only about the plugins this server is actually loading", async () => {
    const { service, seen } = build({
      modePlugins,
      guidelines: [{ disable: true }],
    });

    await service.resolveForServer("server-1");

    const asked = seen.find((entry) => entry.sql.includes("AS disable"));

    expect(asked?.params[0]).toEqual(["inventory-simulator"]);
  });
});
