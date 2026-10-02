import { BadRequestException } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { DedicatedServerConfigService } from "./../src/dedicated-servers/dedicated-server-config.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// One community server's layer over what a plugin's page sets for every
// server. Only the plugins sent are touched, and an empty entry drops back to
// the plugin page's.
describe("server plugin configs (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let service: DedicatedServerConfigService;
  let rebuild: jest.Mock;
  let serverId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("ServerPluginConfigs");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    rebuild = jest.fn().mockResolvedValue(true);
    service = new DedicatedServerConfigService(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      { rebuildDedicatedServer: rebuild } as never,
      {} as never,
    );

    await postgres.query("DELETE FROM servers");
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
         (host, label, rcon_password, port, tv_port, region, type,
          is_dedicated, enabled, game_server_node_id)
       VALUES ('127.0.0.1', 'dm', $1, 27100, 27101, 'TestRegion', 'Custom',
               false, true, 'node-a')
       RETURNING id`,
      [Buffer.from("password")],
    );
    await postgres.query(
      `UPDATE servers SET is_dedicated = true WHERE id = $1`,
      [server.id],
    );
    serverId = server.id;

    await postgres.query(
      `INSERT INTO game_plugins (slug, kind, name, author, description, config_path)
       VALUES ('deathmatch', 'game', 'Deathmatch', 'ianlucas', 'dm', 'modes.json'),
              ('inventory-simulator', 'game', 'Inventory', 'ianlucas', 'inv', NULL)`,
    );
  });

  const stored = async () =>
    await postgres.query<Array<Record<string, unknown>>>(
      `SELECT plugin_slug, cfg, config FROM server_plugin_configs
        ORDER BY plugin_slug`,
    );

  it("stores a server's cvars and file and restarts it once", async () => {
    await service.saveSettings(serverId, {
      mapRotation: null,
      plugins: null,
      pluginConfigs: [
        {
          slug: "deathmatch",
          cfg: "dm_replenish_health 50",
          config: [{ name: "Pistols", weapons: ["deagle"], duration: 60 }],
        },
        {
          slug: "inventory-simulator",
          cfg: "invsim_ws_enabled 0",
          config: null,
        },
      ],
      access: null,
    });

    expect(await stored()).toEqual([
      {
        plugin_slug: "deathmatch",
        cfg: "dm_replenish_health 50",
        config: [{ name: "Pistols", weapons: ["deagle"], duration: 60 }],
      },
      {
        plugin_slug: "inventory-simulator",
        cfg: "invsim_ws_enabled 0",
        config: null,
      },
    ]);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("drops a plugin back to its page's config when the entry is empty", async () => {
    await service.setPluginConfigs(
      serverId,
      [{ slug: "deathmatch", cfg: "dm_replenish_health 50", config: null }],
      { restart: false },
    );
    await service.setPluginConfigs(
      serverId,
      [{ slug: "deathmatch", cfg: "  ", config: null }],
      { restart: false },
    );

    expect(await stored()).toEqual([]);
  });

  it("leaves plugins it was not sent alone", async () => {
    await service.setPluginConfigs(
      serverId,
      [
        { slug: "deathmatch", cfg: "dm_replenish_health 50", config: null },
        {
          slug: "inventory-simulator",
          cfg: "invsim_ws_enabled 0",
          config: null,
        },
      ],
      { restart: false },
    );
    await service.setPluginConfigs(
      serverId,
      [{ slug: "deathmatch", cfg: "dm_replenish_health 75", config: null }],
      { restart: false },
    );

    expect((await stored()).map((row) => row.cfg)).toEqual([
      "dm_replenish_health 75",
      "invsim_ws_enabled 0",
    ]);
  });

  it("refuses a file for a plugin that reads none", async () => {
    await expect(
      service.setPluginConfigs(
        serverId,
        [{ slug: "inventory-simulator", cfg: null, config: { x: 1 } }],
        { restart: false },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await stored()).toEqual([]);
  });

  it("refuses a plugin that is not in the catalog", async () => {
    await expect(
      service.setPluginConfigs(
        serverId,
        [{ slug: "nope", cfg: "x 1", config: null }],
        { restart: false },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a Ranked server, which runs 5Stack's own plugin set", async () => {
    await postgres.query(`UPDATE servers SET type = 'Ranked' WHERE id = $1`, [
      serverId,
    ]);

    await expect(
      service.setPluginConfigs(
        serverId,
        [{ slug: "deathmatch", cfg: "x 1", config: null }],
        { restart: false },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
