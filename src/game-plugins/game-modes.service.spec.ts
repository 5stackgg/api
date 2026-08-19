import { GameModesService } from "./game-modes.service";

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
        if (sql.includes("FROM game_plugin_installs")) {
          return rows.alwaysLoad ?? [];
        }
        return [];
      }),
    };

    const service = new GameModesService(
      { warn: jest.fn(), log: jest.fn() } as never,
      postgres as never,
      { getPluginRuntime: jest.fn(async () => "swiftlys2") } as never,
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
        { plugin_slug: "retakes", config: null, config_path: null, version: "2.0.0" },
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
        { id: "mode-1", slug: "m", name: "M", cfg: null, extra_game_params: null },
      ],
      modePlugins: [
        { plugin_slug: "stats", config: null, config_path: null, version: "2.0.0" },
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
});
