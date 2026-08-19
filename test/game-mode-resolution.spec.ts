import { PostgresService } from "./../src/postgres/postgres.service";
import {
  GameModesService,
  RequiredPluginMissing,
} from "./../src/game-plugins/game-modes.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// What a server is actually told to load, resolved against a real schema. The
// unit specs stub postgres, so the queries themselves -- node scoping, the
// guidelines opt-in -- are only ever checked here.
describe("game mode resolution (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let service: GameModesService;

  beforeAll(async () => {
    db = await bootMigratedDb("GameModeResolution");
    postgres = db.postgres;

    service = new GameModesService(
      { warn: jest.fn(), log: jest.fn() } as never,
      postgres,
      {
        getPluginRuntime: async () => "swiftlys2",
        resolvePluginRuntime: async (pin?: {
          pin_plugin_runtime?: string | null;
        }) => pin?.pin_plugin_runtime ?? "swiftlys2",
      } as never,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  let serverId: string;

  beforeEach(async () => {
    await postgres.query(
      `DELETE FROM settings
        WHERE name IN ('fivestack_ranks_matches', 'fivestack_ranks_tournaments')`,
    );
    await postgres.query("DELETE FROM servers");
    await postgres.query("DELETE FROM game_server_node_plugins");
    await postgres.query("DELETE FROM game_plugin_installs");
    await postgres.query("DELETE FROM game_mode_plugins");
    await postgres.query("DELETE FROM game_modes");
    await postgres.query("DELETE FROM game_plugins");
    await postgres.query("DELETE FROM game_server_nodes");

    await postgres.query(
      `INSERT INTO server_regions (value, description)
       VALUES ('TestRegion', 'TestRegion') ON CONFLICT (value) DO NOTHING`,
    );

    for (const node of ["node-a", "node-b"]) {
      await postgres.query(
        `INSERT INTO game_server_nodes (id, status, enabled, region)
         VALUES ($1, 'Online', true, 'TestRegion')`,
        [node],
      );
    }

    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, region, type, is_dedicated, enabled,
          game_server_node_id)
       VALUES ('127.0.0.1', 'fun', $1, 27015, 'TestRegion', 'Casual', false, true,
               'node-a')
       RETURNING id`,
      [Buffer.from("password")],
    );

    serverId = server.id;
  });

  const catalog = async (
    slug: string,
    { requiresGuidelinesDisabled = false } = {},
  ): Promise<void> => {
    await postgres.query(
      `INSERT INTO game_plugins
         (slug, kind, name, author, description, requires_server_guidelines_disabled)
       VALUES ($1, 'game', $1, 'tester', 'a test plugin', $2)`,
      [slug, requiresGuidelinesDisabled],
    );
  };

  const installed = async (
    slug: string,
    { disableServerGuidelines = false } = {},
  ): Promise<void> => {
    await postgres.query(
      `INSERT INTO game_plugin_installs
         (plugin_slug, version, channel, disable_server_guidelines)
       VALUES ($1, NULL, 'Auto', $2)`,
      [slug, disableServerGuidelines],
    );
  };

  const onNode = async (
    nodeId: string,
    slug: string,
    version: string,
  ): Promise<void> => {
    await postgres.query(
      `INSERT INTO game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, version, detected, status)
       VALUES ($1, $2, 'swiftlys2', $3, true, 'Installed')`,
      [nodeId, slug, version],
    );
  };

  const modeWith = async (
    slug: string,
    { required = true } = {},
  ): Promise<string> => {
    const [mode] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO game_modes (slug, name) VALUES ('skins', 'Skins') RETURNING id`,
    );

    await postgres.query(
      `INSERT INTO game_mode_plugins (game_mode_id, plugin_slug, required)
       VALUES ($1, $2, $3)`,
      [mode.id, slug, required],
    );

    await postgres.query(`UPDATE servers SET game_mode_id = $1 WHERE id = $2`, [
      mode.id,
      serverId,
    ]);

    return mode.id;
  };

  describe("version scoping", () => {
    it("names the version the server's own node has, not another node's", async () => {
      await catalog("retakes");
      await installed("retakes");
      await onNode("node-a", "retakes", "1.0.0");
      await onNode("node-b", "retakes", "1.1.0");
      await modeWith("retakes");

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.enabledPlugins).toEqual("retakes@1.0.0");
    });

    it("refuses to boot a mode whose required plugin never reached that node", async () => {
      await catalog("retakes");
      await installed("retakes");
      await onNode("node-b", "retakes", "1.1.0");
      await modeWith("retakes");

      await expect(service.resolveForServer(serverId)).rejects.toBeInstanceOf(
        RequiredPluginMissing,
      );
    });

    // The mode's cvars and launch params are still its own; only the plugin
    // that never arrived is missing.
    it("boots without a plugin the mode marks optional", async () => {
      await catalog("retakes");
      await installed("retakes");
      await modeWith("retakes", { required: false });

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.slug).toEqual("skins");
      expect(resolved?.enabledPlugins).toEqual("");
    });
  });

  describe("Valve's server guidelines", () => {
    beforeEach(async () => {
      await catalog("inventory-simulator", {
        requiresGuidelinesDisabled: true,
      });
      await onNode("node-a", "inventory-simulator", "1.0.0");
    });

    it("stays on when the operator has not opted in", async () => {
      await installed("inventory-simulator");
      await modeWith("inventory-simulator");

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.disableServerGuidelines).toBe(false);
      expect(service.environmentFor(resolved).map((env) => env.name)).toEqual([
        "ENABLED_PLUGINS",
      ]);
    });

    it("comes off once the operator opts in for that plugin", async () => {
      await installed("inventory-simulator", { disableServerGuidelines: true });
      await modeWith("inventory-simulator");

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.disableServerGuidelines).toBe(true);
      expect(service.environmentFor(resolved)).toContainEqual({
        name: "DISABLE_SERVER_GUIDELINES",
        value: "true",
      });
    });

    // Opting in is per plugin, not per deployment: a server whose mode does not
    // load it has no reason to boot non-compliant.
    it("stays on for a server not loading the plugin", async () => {
      await installed("inventory-simulator", { disableServerGuidelines: true });
      await catalog("retakes");
      await installed("retakes");
      await onNode("node-a", "retakes", "1.0.0");
      await modeWith("retakes");

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.enabledPlugins).toEqual("retakes@1.0.0");
      expect(resolved?.disableServerGuidelines).toBe(false);
    });

    // Ranks flips the same framework setting to render ranks in-game, and the
    // ban it risks is against the account rather than the server -- so once it
    // is on, a plugin that needs the guidelines off already has them off.
    it("comes off for ranks alone, with no per-plugin opt-in", async () => {
      await postgres.query(
        `INSERT INTO settings (name, value) VALUES ('fivestack_ranks_matches', 'true')
         ON CONFLICT (name) DO UPDATE SET value = 'true'`,
      );

      await installed("inventory-simulator");
      await modeWith("inventory-simulator");

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.disableServerGuidelines).toBe(true);
    });

    it("stays on while ranks is off and nobody opted in", async () => {
      await postgres.query(
        `INSERT INTO settings (name, value) VALUES ('fivestack_ranks_matches', 'false')
         ON CONFLICT (name) DO UPDATE SET value = 'false'`,
      );

      await installed("inventory-simulator");
      await modeWith("inventory-simulator");

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.disableServerGuidelines).toBe(false);
    });

    // always_load reaches every server including ranked, so the opt-in has to
    // follow it there rather than only applying to modes.
    it("follows an always-load plugin onto a server with no mode", async () => {
      await installed("inventory-simulator", { disableServerGuidelines: true });
      await postgres.query(
        `UPDATE game_plugin_installs SET always_load = true
          WHERE plugin_slug = 'inventory-simulator'`,
      );

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.enabledPlugins).toEqual("inventory-simulator@1.0.0");
      expect(resolved?.disableServerGuidelines).toBe(true);
    });
  });
});
