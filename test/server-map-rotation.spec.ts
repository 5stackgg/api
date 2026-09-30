import { PostgresService } from "./../src/postgres/postgres.service";
import { DedicatedServerConfigService } from "./../src/dedicated-servers/dedicated-server-config.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// What the dedicated server page saves: a map rotation, per-server plugin
// overrides, and workshop maps imported from a Steam collection.
describe("dedicated server config (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let service: DedicatedServerConfigService;

  const dedicatedServers = {
    rebuildDedicatedServer: jest.fn(async () => true),
  };

  beforeAll(async () => {
    db = await bootMigratedDb("DedicatedServerConfig");
    postgres = db.postgres;

    service = new DedicatedServerConfigService(
      { warn: jest.fn(), log: jest.fn() } as never,
      postgres,
      dedicatedServers as never,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  let serverId: string;

  beforeEach(async () => {
    jest.clearAllMocks();

    await postgres.query("DELETE FROM servers");
    await postgres.query("DELETE FROM game_plugin_installs");
    await postgres.query("DELETE FROM game_plugins");
    await postgres.query("DELETE FROM game_server_nodes");
    await postgres.query("DELETE FROM maps WHERE workshop_map_id LIKE '9%'");
    await postgres.query("DELETE FROM maps WHERE name LIKE 'rotation-%'");

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
         (host, label, rcon_password, port, tv_port, region, type, is_dedicated,
          enabled, game_server_node_id)
       VALUES ('127.0.0.1', 'public', $1, 27015, 27020, 'TestRegion', 'Casual',
               false, true, 'node-a')
       RETURNING id`,
      [Buffer.from("password")],
    );
    await postgres.query(
      `UPDATE servers SET is_dedicated = true WHERE id = $1`,
      [server.id],
    );

    serverId = server.id;
  });

  const map = async (name: string, deleted = false): Promise<string> => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO maps (name, type, enabled, active_pool, deleted_at)
       VALUES ($1, 'Competitive', false, false, $2)
       RETURNING id`,
      [name, deleted ? new Date() : null],
    );

    return row.id;
  };

  const rotation = async (): Promise<Array<string>> =>
    (
      await postgres.query<Array<{ map_id: string }>>(
        `SELECT map_id FROM server_map_rotation
          WHERE server_id = $1 ORDER BY position`,
        [serverId],
      )
    ).map((row) => row.map_id);

  describe("setMapRotation", () => {
    it("replaces the rotation in the order given, once per map, and restarts the server", async () => {
      const a = await map("rotation-a");
      const b = await map("rotation-b");
      const c = await map("rotation-c");

      await service.setMapRotation(serverId, [a, b], true);
      await service.setMapRotation(serverId, [c, a, c], false);

      expect(await rotation()).toEqual([c, a]);

      const [server] = await postgres.query<Array<{ shuffle: boolean }>>(
        `SELECT map_rotation_shuffle AS shuffle FROM servers WHERE id = $1`,
        [serverId],
      );
      expect(server.shuffle).toBe(false);
      expect(dedicatedServers.rebuildDedicatedServer).toHaveBeenCalledTimes(2);
    });

    it("clears the rotation when given no maps", async () => {
      await service.setMapRotation(serverId, [await map("rotation-a")], true);
      await service.setMapRotation(serverId, [], true);

      expect(await rotation()).toEqual([]);
    });

    // The page can still list a map deleted after it loaded; failing the
    // save would block every later edit until the page was reloaded.
    it("drops a deleted map instead of refusing the save", async () => {
      const a = await map("rotation-a");
      const gone = await map("rotation-gone", true);

      await service.setMapRotation(serverId, [gone, a], false);

      expect(await rotation()).toEqual([a]);
    });

    it("refuses a map that does not exist", async () => {
      const a = await map("rotation-a");
      await service.setMapRotation(serverId, [a], true);

      await expect(
        service.setMapRotation(
          serverId,
          [a, "00000000-0000-0000-0000-00000000dead"],
          true,
        ),
      ).rejects.toThrow(/does not exist/);

      expect(await rotation()).toEqual([a]);
    });

    // The settings reach the server in its pod spec, so a disabled server
    // picks them up the next time it is enabled rather than being started.
    it("saves without starting a disabled server", async () => {
      await postgres.query(`UPDATE servers SET enabled = false WHERE id = $1`, [
        serverId,
      ]);

      await service.setMapRotation(serverId, [await map("rotation-a")], true);

      expect(dedicatedServers.rebuildDedicatedServer).not.toHaveBeenCalled();
    });

    it("refuses Ranked servers", async () => {
      await postgres.query(`UPDATE servers SET type = 'Ranked' WHERE id = $1`, [
        serverId,
      ]);

      await expect(
        service.setMapRotation(serverId, [await map("rotation-a")], true),
      ).rejects.toThrow(/Ranked servers/);
    });

    it("refuses an external server, which has no pod to configure", async () => {
      const [external] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, tv_port, region, type,
            is_dedicated, enabled)
         VALUES ('10.0.0.1', 'external', $1, 27015, 27020, 'TestRegion',
                 'Casual', true, true)
         RETURNING id`,
        [Buffer.from("password")],
      );

      await expect(
        service.setMapRotation(external.id, [await map("rotation-a")], true),
      ).rejects.toThrow(/game server node/);
    });
  });

  describe("setPlugins", () => {
    beforeEach(async () => {
      for (const slug of ["csroll", "map-chooser"]) {
        await postgres.query(
          `INSERT INTO game_plugins (slug, kind, name, author, description)
           VALUES ($1, 'game', $1, 'tester', 'a test plugin')`,
          [slug],
        );
        await postgres.query(
          `INSERT INTO game_plugin_installs (plugin_slug, version, channel)
           VALUES ($1, NULL, 'Auto')`,
          [slug],
        );
      }
    });

    const overrides = async () =>
      await postgres.query<Array<{ plugin_slug: string; enabled: boolean }>>(
        `SELECT plugin_slug, enabled FROM server_plugins
          WHERE server_id = $1 ORDER BY plugin_slug`,
        [serverId],
      );

    it("replaces every override with the ones given", async () => {
      await service.setPlugins(serverId, [
        { slug: "csroll", enabled: true },
        { slug: "map-chooser", enabled: false },
      ]);
      await service.setPlugins(serverId, [{ slug: "csroll", enabled: false }]);

      expect(await overrides()).toEqual([
        { plugin_slug: "csroll", enabled: false },
      ]);
    });

    it("refuses a plugin that is not installed", async () => {
      await expect(
        service.setPlugins(serverId, [{ slug: "nope", enabled: true }]),
      ).rejects.toThrow(/server_plugins_install_fkey/);
    });

    it("forgets a server's override when the plugin is uninstalled", async () => {
      await service.setPlugins(serverId, [{ slug: "csroll", enabled: true }]);
      await postgres.query(
        `DELETE FROM game_plugin_installs WHERE plugin_slug = 'csroll'`,
      );

      expect(await overrides()).toEqual([]);
    });
  });

  describe("importWorkshopCollection", () => {
    const steam = (responses: Record<string, unknown>) =>
      jest
        .spyOn(global, "fetch")
        .mockImplementation(async (url: string | URL | Request) => {
          const method = Object.keys(responses).find((name) =>
            url.toString().includes(`/${name}/`),
          );

          return new Response(JSON.stringify(responses[method]), {
            status: 200,
          });
        });

    const item = (id: string, title: string, extra = {}) => ({
      publishedfileid: id,
      result: 1,
      consumer_app_id: 730,
      banned: 0,
      title,
      preview_url: `https://img/${id}.jpg`,
      tags: [{ tag: "Cs2" }, { tag: "Map" }],
      ...extra,
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("catalogues every CS2 map in the collection in order, disabled for matches", async () => {
      steam({
        GetCollectionDetails: {
          response: {
            collectiondetails: [
              {
                result: 1,
                children: [
                  { publishedfileid: "92", sortorder: 2, filetype: 0 },
                  { publishedfileid: "91", sortorder: 1, filetype: 0 },
                  { publishedfileid: "93", sortorder: 3, filetype: 2 },
                  { publishedfileid: "94", sortorder: 4, filetype: 0 },
                ],
              },
            ],
          },
        },
        GetPublishedFileDetails: {
          response: {
            publishedfiledetails: [
              item("91", "Prophunt Dust2"),
              item("92", "Prophunt Mirage"),
              item("94", "A CS:GO map", { consumer_app_id: 4000 }),
            ],
          },
        },
      });

      const result = await service.importWorkshopCollection(
        "https://steamcommunity.com/sharedfiles/filedetails/?id=90",
      );

      expect(result.skipped).toBe(1);
      expect(
        result.maps.map((m) => [m.workshop_map_id, m.name, m.label]),
      ).toEqual([
        ["91", "91", "Prophunt Dust2"],
        ["92", "92", "Prophunt Mirage"],
      ]);

      const rows = await postgres.query<
        Array<{ type: string; enabled: boolean; active_pool: boolean }>
      >(
        `SELECT type, enabled, active_pool FROM maps
          WHERE workshop_map_id IN ('91', '92')`,
      );
      expect(rows).toEqual([
        { type: "Competitive", enabled: false, active_pool: false },
        { type: "Competitive", enabled: false, active_pool: false },
      ]);
    });

    it("reuses a map already in the catalog and restores one that was deleted", async () => {
      const [existing] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO maps
           (name, label, workshop_map_id, type, enabled, active_pool, deleted_at)
         VALUES ('91', 'My Label', '91', 'Wingman', true, false, now())
         RETURNING id`,
      );

      steam({
        GetCollectionDetails: {
          response: { collectiondetails: [{ result: 9 }] },
        },
        GetPublishedFileDetails: {
          response: { publishedfiledetails: [item("91", "Prophunt Dust2")] },
        },
      });

      const result = await service.importWorkshopCollection("91");

      expect(result.maps).toEqual([
        {
          id: existing.id,
          name: "91",
          label: "My Label",
          poster: null,
          workshop_map_id: "91",
        },
      ]);

      const [row] = await postgres.query<Array<{ deleted_at: Date | null }>>(
        `SELECT deleted_at FROM maps WHERE id = $1`,
        [existing.id],
      );
      expect(row.deleted_at).toBeNull();
    });

    // Skins, stickers and collections are app-730 workshop items as well.
    it("skips workshop items that are not maps", async () => {
      steam({
        GetCollectionDetails: {
          response: {
            collectiondetails: [
              {
                result: 1,
                children: [
                  { publishedfileid: "91", sortorder: 1, filetype: 0 },
                  { publishedfileid: "95", sortorder: 2, filetype: 0 },
                ],
              },
            ],
          },
        },
        GetPublishedFileDetails: {
          response: {
            publishedfiledetails: [
              item("91", "Prophunt Dust2"),
              item("95", "AK-47 | Some Skin", {
                tags: [{ tag: "Cs2" }, { tag: "Weapon Finish" }],
              }),
            ],
          },
        },
      });

      const result = await service.importWorkshopCollection("90");

      expect(result.skipped).toBe(1);
      expect(result.maps.map((m) => m.workshop_map_id)).toEqual(["91"]);
    });

    // Restoring a map that was in the active pool would put it back into the
    // seed pools matchmaking and vetoes play from.
    it("restores a deleted map disabled and out of the match pools", async () => {
      await postgres.query(
        `INSERT INTO settings (name, value) VALUES ('update_map_pools', 'true')
         ON CONFLICT (name) DO UPDATE SET value = 'true'`,
      );
      await postgres.query(
        `INSERT INTO maps
           (name, label, workshop_map_id, type, enabled, active_pool, deleted_at)
         VALUES ('96', 'Was Active', '96', 'Competitive', true, true, now())`,
      );

      steam({
        GetCollectionDetails: {
          response: { collectiondetails: [{ result: 9 }] },
        },
        GetPublishedFileDetails: {
          response: { publishedfiledetails: [item("96", "Was Active")] },
        },
      });

      await service.importWorkshopCollection("96");

      const [row] = await postgres.query<
        Array<{ enabled: boolean; active_pool: boolean; pools: number }>
      >(
        `SELECT m.enabled, m.active_pool,
                (SELECT count(*)::int FROM _map_pool mp WHERE mp.map_id = m.id) AS pools
           FROM maps m
          WHERE m.workshop_map_id = '96'`,
      );
      expect(row).toEqual({ enabled: false, active_pool: false, pools: 0 });
    });

    it("says so when nothing in the link is a CS2 map", async () => {
      steam({
        GetCollectionDetails: {
          response: { collectiondetails: [{ result: 9 }] },
        },
        GetPublishedFileDetails: {
          response: {
            publishedfiledetails: [{ publishedfileid: "99", result: 9 }],
          },
        },
      });

      await expect(service.importWorkshopCollection("99")).rejects.toThrow(
        /no public CS2 workshop maps/,
      );
    });
  });

  describe("workshopId", () => {
    it("reads a bare id or the id out of a workshop link", () => {
      expect(DedicatedServerConfigService.workshopId(" 3615968422 ")).toEqual(
        "3615968422",
      );
      expect(
        DedicatedServerConfigService.workshopId(
          "https://steamcommunity.com/sharedfiles/filedetails/?id=3615968422&searchtext=",
        ),
      ).toEqual("3615968422");
      expect(DedicatedServerConfigService.workshopId("prophunt")).toBeNull();
    });
  });
});
