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
    await postgres.query("DELETE FROM matches");
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

  const autoLoads = async (
    slug: string,
    { ranked = true, tournaments = true, custom = true } = {},
  ): Promise<void> => {
    await postgres.query(
      `UPDATE game_plugin_installs
          SET load_ranked = $2, load_tournaments = $3, load_custom = $4
        WHERE plugin_slug = $1`,
      [slug, ranked, tournaments, custom],
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

    // Auto-loading reaches every server including ranked, so the opt-in has to
    // follow it there rather than only applying to modes.
    it("follows an auto-load plugin onto a server with no mode", async () => {
      await installed("inventory-simulator", { disableServerGuidelines: true });
      await autoLoads("inventory-simulator");

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.enabledPlugins).toEqual("inventory-simulator@1.0.0");
      expect(resolved?.disableServerGuidelines).toBe(true);
    });
  });
  // Which kinds of match a plugin loads on by itself. Ranked means the match
  // counts toward ranking, not that matchmaking made it.
  describe("auto-load targets", () => {
    const forScope = async (match?: "ranked" | "tournaments" | "custom") =>
      await service.autoLoadPlugins({
        nodeId: "node-a",
        runtime: "swiftlys2",
        match,
      });

    // Goes through resolveForServer so the is_ranked / is_tournament subqueries
    // are actually executed. session_replication_role skips the veto trigger on
    // matches, which needs a whole region/map-pool fixture this does not.
    const matchOn = async (
      server: string,
      { ranked = true, tournament = false } = {},
    ): Promise<string> => {
      const [l1] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
      );
      const [l2] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
      );

      await postgres.query("ALTER TABLE public.matches DISABLE TRIGGER USER");
      let match: { id: string };
      try {
        [match] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO matches
             (lineup_1_id, lineup_2_id, server_id, counts_toward_ranking)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [l1.id, l2.id, server, ranked],
        );
      } finally {
        await postgres.query("ALTER TABLE public.matches ENABLE TRIGGER USER");
      }

      if (tournament) {
        const [pool] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO map_pools (type) VALUES ('Competitive') RETURNING id`,
        );
        const [options] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO match_options
             (mr, best_of, type, map_veto, region_veto, map_pool_id)
           VALUES (12, 1, 'Competitive', false, false, $1) RETURNING id`,
          [pool.id],
        );
        await postgres.query(
          `INSERT INTO players (steam_id, name)
           VALUES (76561190000000000, 'organizer')
           ON CONFLICT (steam_id) DO NOTHING`,
        );
        const [t] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO tournaments (name, organizer_steam_id, start, match_options_id)
           VALUES ('T', 76561190000000000, now(), $1) RETURNING id`,
          [options.id],
        );
        const [stage] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO tournament_stages
             (tournament_id, type, "order", min_teams, max_teams)
           VALUES ($1, 'SingleElimination', 1, 4, 8) RETURNING id`,
          [t.id],
        );
        await postgres.query(
          `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round)
           VALUES ($1, $2, 1)`,
          [stage.id, match.id],
        );
      }
      return match.id;
    };

    it("buckets a real match by counts_toward_ranking, not by how it was made", async () => {
      await autoLoads("inventory-simulator", {
        ranked: true,
        tournaments: false,
        custom: false,
      });

      const ranked = await matchOn(serverId, { ranked: true });
      expect(
        (await service.resolveForServer(serverId, ranked))?.enabledPlugins,
      ).toEqual("inventory-simulator@1.0.0");

      const casual = await matchOn(serverId, { ranked: false });
      expect(
        (await service.resolveForServer(serverId, casual))?.enabledPlugins ??
          "",
      ).toEqual("");
    });

    // Both flags true must resolve to the tournament bucket, so a ranked-only
    // plugin stays out of a tournament game.
    it("sends a ranked tournament match to the tournament bucket", async () => {
      await autoLoads("inventory-simulator", {
        ranked: true,
        tournaments: false,
        custom: false,
      });

      const match = await matchOn(serverId, { ranked: true, tournament: true });

      expect(
        (await service.resolveForServer(serverId, match))?.enabledPlugins ?? "",
      ).toEqual("");
    });

    beforeEach(async () => {
      await catalog("inventory-simulator");
      await onNode("node-a", "inventory-simulator", "1.0.0");
      await installed("inventory-simulator");
    });

    // Installing a plugin is not consent to run it on every server.
    it("loads nowhere until a target is turned on", async () => {
      expect(await forScope("ranked")).toEqual([]);
      expect(await forScope("tournaments")).toEqual([]);
      expect(await forScope("custom")).toEqual([]);
    });

    it("loads only where its target says", async () => {
      await autoLoads("inventory-simulator", {
        ranked: true,
        tournaments: false,
        custom: false,
      });

      expect(await forScope("ranked")).toEqual(["inventory-simulator@1.0.0"]);
      expect(await forScope("tournaments")).toEqual([]);
      expect(await forScope("custom")).toEqual([]);
    });

    it("keeps a customs-only plugin out of ranked and tournaments", async () => {
      await autoLoads("inventory-simulator", {
        ranked: false,
        tournaments: false,
        custom: true,
      });

      expect(await forScope("custom")).toEqual(["inventory-simulator@1.0.0"]);
      expect(await forScope("ranked")).toEqual([]);
      expect(await forScope("tournaments")).toEqual([]);
    });

    // A dedicated server is built before it has a match, so gating it on a
    // guess would drop plugins it is meant to carry.
    it("falls back to anything that loads somewhere with no match", async () => {
      await autoLoads("inventory-simulator", {
        ranked: false,
        tournaments: false,
        custom: true,
      });

      expect(await forScope()).toEqual(["inventory-simulator@1.0.0"]);
    });

    // The pod's plugin set is fixed at build time, so a Ranked dedicated server
    // has to be resolved as ranked even though it has no match yet -- otherwise
    // a customs-only plugin is baked into the server matchmaking draws from.
    it("keeps a customs-only plugin out of a dedicated ranked server", async () => {
      await autoLoads("inventory-simulator", {
        ranked: false,
        tournaments: false,
        custom: true,
      });

      const [ranked] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, region, type, is_dedicated, enabled,
            game_server_node_id)
         VALUES ('127.0.0.1', 'ranked', $1, 27017, 'TestRegion', 'Ranked', false,
                 true, 'node-a')
         RETURNING id`,
        [Buffer.from("password")],
      );

      expect(
        (await service.resolveForServer(ranked.id))?.enabledPlugins ?? "",
      ).toEqual("");
    });

    it("stays out of the answer once the install is disabled", async () => {
      await autoLoads("inventory-simulator");
      await postgres.query(
        `UPDATE game_plugin_installs SET enabled = false
          WHERE plugin_slug = 'inventory-simulator'`,
      );

      expect(await forScope("ranked")).toEqual([]);
    });

    // The buckets do not overlap: a ranked tournament game is a tournament
    // game, so a plugin set to ranked-only stays out of it.
    it("reads tournament ahead of ranked, and custom last", () => {
      expect(
        GameModesService.matchScope({ isTournament: true, isRanked: true }),
      ).toEqual("tournaments");
      expect(
        GameModesService.matchScope({ isTournament: false, isRanked: true }),
      ).toEqual("ranked");
      expect(
        GameModesService.matchScope({ isTournament: false, isRanked: false }),
      ).toEqual("custom");
    });
  });

  describe("plugin cfg layers", () => {
    beforeEach(async () => {
      await catalog("inventory-simulator");
      await catalog("retakes");
      await onNode("node-a", "inventory-simulator", "1.0.0");
      await onNode("node-a", "retakes", "2.0.0");
    });

    it("hands back the cvars of every plugin that loads, in load order", async () => {
      await postgres.query(
        `INSERT INTO game_plugin_installs (plugin_slug, version, channel, cfg)
         VALUES ('retakes', NULL, 'Auto', 'mp_freezetime 3'),
                ('inventory-simulator', NULL, 'Auto', 'invsim_ws_enabled 1')`,
      );

      const [mode] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO game_modes (slug, name) VALUES ('fun', 'Fun') RETURNING id`,
      );
      await postgres.query(
        `INSERT INTO game_mode_plugins (game_mode_id, plugin_slug, load_order)
         VALUES ($1, 'inventory-simulator', 1), ($1, 'retakes', 2)`,
        [mode.id],
      );
      await postgres.query(
        `UPDATE servers SET game_mode_id = $1 WHERE id = $2`,
        [mode.id, serverId],
      );

      const resolved = await service.resolveForServer(serverId);

      expect(await service.pluginCfgLayers(resolved)).toEqual([
        { slug: "inventory-simulator", cfg: "invsim_ws_enabled 1" },
        { slug: "retakes", cfg: "mp_freezetime 3" },
      ]);
    });

    // A blank cfg would write an empty file over the layer and exec nothing,
    // which is not the same as having no layer at all.
    it("skips a plugin whose cvars are empty or unset", async () => {
      await postgres.query(
        `INSERT INTO game_plugin_installs
           (plugin_slug, version, channel, load_custom, cfg)
         VALUES ('retakes', NULL, 'Auto', true, '   '),
                ('inventory-simulator', NULL, 'Auto', true, NULL)`,
      );

      const resolved = await service.resolveForServer(serverId);

      expect(resolved?.enabledPlugins).toContain("retakes@2.0.0");
      expect(await service.pluginCfgLayers(resolved)).toEqual([]);
    });

    it("has nothing to say when no plugin loads", async () => {
      expect(await service.pluginCfgLayers(null)).toEqual([]);
    });
  });
});
