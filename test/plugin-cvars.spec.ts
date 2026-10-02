import { PostgresService } from "./../src/postgres/postgres.service";
import {
  ListedCvar,
  PluginCvarsService,
} from "./../src/game-plugins/plugin-cvars.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The catalog names a plugin's cvars; a server running the plugin is what says
// what each one is for and what it defaults to.
describe("plugin cvar harvest (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let service: PluginCvarsService;
  let cache: Map<string, unknown>;
  let serverId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("PluginCvars");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    cache = new Map();
    service = new PluginCvarsService(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      {
        has: async (key: string) => cache.has(key),
        put: async (key: string, value: unknown) => {
          cache.set(key, value);
        },
      } as never,
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
    await postgres.query(
      `INSERT INTO game_server_nodes (id, status, enabled, region)
       VALUES ('node-a', 'Online', true, 'TestRegion')`,
    );

    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, region, type, is_dedicated, enabled,
          game_server_node_id)
       VALUES ('127.0.0.1', 'dm', $1, 27015, 'TestRegion', 'Custom', false, true,
               'node-a')
       RETURNING id`,
      [Buffer.from("password")],
    );
    serverId = server.id;

    await postgres.query(
      `INSERT INTO game_plugins (slug, kind, name, author, description, cvars)
       VALUES ('deathmatch', 'game', 'Deathmatch', 'ianlucas', 'dm',
               ARRAY['dm_replenish_health', 'dm_chat_prefix', 'dm_pro_ratio'])`,
    );
    await postgres.query(
      `INSERT INTO game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, version, detected, status)
       VALUES ('node-a', 'deathmatch', 'swiftlys2', '1.1.2', true, 'Installed')`,
    );
  });

  const server: Record<string, ListedCvar> = {
    dm_replenish_health: {
      name: "dm_replenish_health",
      kind: "10",
      flags: "sv",
      description: "Amount of health replenished on kill.",
    },
    dm_replenish_health_headshot: {
      name: "dm_replenish_health_headshot",
      kind: "25",
      flags: "sv",
      description: "Amount of health replenished on headshot kill.",
    },
    dm_chat_prefix: {
      name: "dm_chat_prefix",
      kind: "[{red}Deathmatch{default}]",
      flags: "sv",
      description: "Prefix displayed before chat messages.",
    },
    dm_pro_ratio: {
      name: "dm_pro_ratio",
      kind: "",
      flags: "sv",
      description: "Target K/D ratio.",
    },
  };

  // Cvarlist matches by prefix, so asking for one name can answer with others.
  const list = jest.fn(async (prefix: string) =>
    Object.values(server).filter((cvar) => cvar.name.startsWith(prefix)),
  );

  const reported = async () =>
    await postgres.query<Array<Record<string, unknown>>>(
      `SELECT name, kind, default_value, description, version, runtime
         FROM game_plugin_cvars ORDER BY name`,
    );

  it("records what a server running the plugin says about each cvar", async () => {
    await service.harvest(serverId, list);

    expect(await reported()).toEqual([
      {
        name: "dm_chat_prefix",
        kind: "string",
        default_value: "[{red}Deathmatch{default}]",
        description: "Prefix displayed before chat messages.",
        version: "1.1.2",
        runtime: "swiftlys2",
      },
      expect.objectContaining({
        name: "dm_pro_ratio",
        kind: "string",
        default_value: "",
      }),
      expect.objectContaining({
        name: "dm_replenish_health",
        kind: "int",
        default_value: "10",
      }),
    ]);
  });

  // An operator's value is not what the plugin ships with.
  it("does not take a value the panel set as the default", async () => {
    await postgres.query(
      `INSERT INTO game_plugin_installs (plugin_slug, version, channel, cfg)
       VALUES ('deathmatch', NULL, 'Auto', 'dm_replenish_health 50 // more')`,
    );

    await service.harvest(serverId, list);

    const [health] = (await reported()).filter(
      (row) => row.name === "dm_replenish_health",
    );
    expect(health).toEqual(
      expect.objectContaining({ kind: "int", default_value: null }),
    );
  });

  it.each([
    ["a quoted name", `"dm_replenish_health" "50"`],
    ["commands sharing a line", "sv_cheats 0; dm_replenish_health 50"],
  ])("does not take a value set by %s as the default", async (_, cfg) => {
    await postgres.query(
      `INSERT INTO game_plugin_installs (plugin_slug, version, channel, cfg)
       VALUES ('deathmatch', NULL, 'Auto', $1)`,
      [cfg],
    );

    await service.harvest(serverId, list);

    const [health] = (await reported()).filter(
      (row) => row.name === "dm_replenish_health",
    );
    expect(health.default_value).toBeNull();
  });

  it("does not take a value a mode's launch parameters set as the default", async () => {
    await postgres.query(
      `INSERT INTO game_modes (slug, name, extra_game_params)
       VALUES ('dm', 'DM', '+dm_replenish_health 50 +sv_cheats 0')`,
    );

    await service.harvest(serverId, list);

    const [health] = (await reported()).filter(
      (row) => row.name === "dm_replenish_health",
    );
    expect(health.default_value).toBeNull();
  });

  // The panel points the cvar at the file it writes, so what the server holds
  // is the panel's path, not the plugin's.
  it("does not take a config file's path as the default", async () => {
    await postgres.query(
      `UPDATE game_plugins SET config_cvar = 'dm_chat_prefix' WHERE slug = 'deathmatch'`,
    );
    await postgres.query(
      `INSERT INTO game_plugin_installs (plugin_slug, version, channel, config)
       VALUES ('deathmatch', NULL, 'Auto', '[]')`,
    );

    await service.harvest(serverId, list);

    const [prefix] = (await reported()).filter(
      (row) => row.name === "dm_chat_prefix",
    );
    expect(prefix.default_value).toBeNull();
  });

  it("never records a secret as a default", async () => {
    await postgres.query(
      `UPDATE game_plugins SET cvars = ARRAY['invsim_apikey'] WHERE slug = 'deathmatch'`,
    );
    const keyed = jest.fn(async () => [
      {
        name: "invsim_apikey",
        kind: "inv_123",
        flags: "sv",
        description: "API key.",
      },
    ]);

    await service.harvest(serverId, keyed);

    expect(await reported()).toEqual([
      expect.objectContaining({
        name: "invsim_apikey",
        kind: "string",
        default_value: null,
      }),
    ]);
  });

  it("keeps a default it already knew when the panel now sets the cvar", async () => {
    await service.harvest(serverId, list);
    await postgres.query(
      `UPDATE game_server_node_plugins SET version = '1.2.0'`,
    );
    await postgres.query(
      `INSERT INTO game_modes (slug, name, cfg)
       VALUES ('dm', 'DM', 'dm_replenish_health 50')`,
    );

    await service.harvest(serverId, list);

    const [health] = (await reported()).filter(
      (row) => row.name === "dm_replenish_health",
    );
    expect(health).toEqual(
      expect.objectContaining({ version: "1.2.0", default_value: "10" }),
    );
  });

  it("asks once per installed version", async () => {
    await service.harvest(serverId, list);
    list.mockClear();

    await service.harvest(serverId, list);

    expect(list).not.toHaveBeenCalled();
  });

  // Installed on the node is not loaded on this server; another server that
  // does run it will answer.
  it("records nothing and waits when the plugin is not loaded here", async () => {
    const none = jest.fn(async () => [] as Array<ListedCvar>);

    await service.harvest(serverId, none);
    await service.harvest(serverId, none);

    expect(await reported()).toEqual([]);
    expect(none).toHaveBeenCalledTimes(3);
  });

  it("drops a cvar the catalog stops listing", async () => {
    await service.harvest(serverId, list);
    await postgres.query(
      `UPDATE game_plugins SET cvars = ARRAY['dm_replenish_health', 'dm_chat_prefix']`,
    );

    await service.harvest(serverId, list);

    expect((await reported()).map((row) => row.name)).toEqual([
      "dm_chat_prefix",
      "dm_replenish_health",
    ]);
  });

  // The catalog's list is part of what was read, so a cvar it adds is picked
  // up without waiting for the plugin's next release.
  it("reads a cvar the catalog starts listing", async () => {
    await postgres.query(
      `UPDATE game_plugins SET cvars = ARRAY['dm_replenish_health']`,
    );
    await service.harvest(serverId, list);
    await postgres.query(
      `UPDATE game_plugins SET cvars = ARRAY['dm_replenish_health', 'dm_chat_prefix']`,
    );

    await service.harvest(serverId, list);

    expect((await reported()).map((row) => row.name)).toEqual([
      "dm_chat_prefix",
      "dm_replenish_health",
    ]);
  });

  // Two nodes on different releases used to overwrite each other's rows and
  // re-read every minute, forever.
  it("settles when servers run different releases", async () => {
    await postgres.query(
      `INSERT INTO game_server_nodes (id, status, enabled, region)
       VALUES ('node-b', 'Online', true, 'TestRegion')`,
    );
    await postgres.query(
      `INSERT INTO game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, version, detected, status)
       VALUES ('node-b', 'deathmatch', 'swiftlys2', '1.2.0', true, 'Installed')`,
    );
    const [other] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, region, type, is_dedicated, enabled,
          game_server_node_id)
       VALUES ('127.0.0.2', 'dm-b', $1, 27016, 'TestRegion', 'Custom', false, true,
               'node-b')
       RETURNING id`,
      [Buffer.from("password")],
    );

    await service.harvest(serverId, list);
    await service.harvest(other.id, list);
    list.mockClear();

    await service.harvest(serverId, list);
    await service.harvest(other.id, list);

    expect(list).not.toHaveBeenCalled();
  });

  it("asks a server that just restarted, which may load the plugin now", async () => {
    const none = jest.fn(async () => [] as Array<ListedCvar>);
    await service.harvest(serverId, none);

    await service.harvest(serverId, list, { restarted: true });

    expect((await reported()).length).toEqual(3);
  });

  it("only asks about plugins on the server's own node", async () => {
    await postgres.query(
      `INSERT INTO game_server_nodes (id, status, enabled, region)
       VALUES ('node-b', 'Online', true, 'TestRegion')`,
    );
    await postgres.query(
      `UPDATE game_server_node_plugins SET game_server_node_id = 'node-b'`,
    );

    await service.harvest(serverId, list);

    expect(await reported()).toEqual([]);
  });
});

describe("PluginCvarsService.kindOf", () => {
  it.each([
    ["true", "bool"],
    ["false", "bool"],
    ["10", "int"],
    ["-3", "int"],
    ["0.5", "float"],
    ["1.000000", "float"],
    ["https://inventory.5stack.gg", "string"],
    ["", "string"],
  ])("reads %p as %p", (value, kind) => {
    expect(PluginCvarsService.kindOf(value)).toEqual(kind);
  });
});
