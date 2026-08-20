import { PostgresService } from "./../src/postgres/postgres.service";
import { GamePluginsService } from "./../src/game-plugins/game-plugins.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Installing states intent and nodes converge to it, so "installed" is a count
// rather than a flag. These are the states the directory renders.
describe("game plugin install state (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("GamePluginInstallState");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM game_server_node_plugins");
    await postgres.query("DELETE FROM game_plugin_installs");
    await postgres.query("DELETE FROM game_plugins");
    await postgres.query("DELETE FROM game_server_nodes");

    await postgres.query(
      `INSERT INTO server_regions (value, description)
       VALUES ('TestRegion', 'TestRegion') ON CONFLICT (value) DO NOTHING`,
    );

    await postgres.query(
      `INSERT INTO game_plugins (slug, kind, name, author, description)
       VALUES ('retakes', 'game', 'Retakes', 'someone', 'a plugin')`,
    );
  });

  const addNode = async (id: string, status = "Online", enabled = true) => {
    await postgres.query(
      `INSERT INTO game_server_nodes (id, status, enabled, region)
       VALUES ($1, $2, $3, 'TestRegion')`,
      [id, status, enabled],
    );
  };

  const request = async (version: string | null = null) => {
    await postgres.query(
      `INSERT INTO game_plugin_installs (plugin_slug, version, channel)
       VALUES ('retakes', $1, $2)`,
      [version, version ? "Pinned" : "Auto"],
    );
  };

  const observe = async (
    nodeId: string,
    { source = "managed", detected = true, status = "Installed" } = {},
  ) => {
    await postgres.query(
      `INSERT INTO game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, version, detected, source, status)
       VALUES ($1, 'retakes', 'swiftlys2', '1.0.0', $2, $3, $4)`,
      [nodeId, detected, source, status],
    );
  };

  const state = async (): Promise<string> => {
    const [row] = await postgres.query<Array<{ state: string }>>(
      `SELECT game_plugin_install_state(p.*) AS state FROM game_plugins p WHERE slug = 'retakes'`,
    );
    return row.state;
  };

  it("is NotInstalled when nobody asked for it", async () => {
    await addNode("node-1");
    expect(await state()).toEqual("NotInstalled");
  });

  it("is Pending once requested, before any node has converged", async () => {
    await addNode("node-1");
    await request();
    expect(await state()).toEqual("Pending");
  });

  it("is Partial while only some nodes have it", async () => {
    await addNode("node-1");
    await addNode("node-2");
    await request();
    await observe("node-1");
    expect(await state()).toEqual("Partial");
  });

  it("is Installed once every node has it", async () => {
    await addNode("node-1");
    await addNode("node-2");
    await request();
    await observe("node-1");
    await observe("node-2");
    expect(await state()).toEqual("Installed");
  });

  it("is Failed when a node could not install it", async () => {
    await addNode("node-1");
    await addNode("node-2");
    await request();
    await observe("node-1");
    await observe("node-2", { detected: false, status: "Failed" });
    expect(await state()).toEqual("Failed");
  });

  it("is Manual for a plugin dropped in by hand", async () => {
    await addNode("node-1");
    await observe("node-1", { source: "manual" });
    expect(await state()).toEqual("Manual");
  });

  it("ignores disabled and offline nodes when deciding completeness", async () => {
    await addNode("node-1");
    await addNode("node-2", "Offline");
    await addNode("node-3", "Online", false);
    await request();
    await observe("node-1");
    // node-2 is offline and node-3 is disabled, so node-1 alone is everything
    // that could have converged.
    expect(await state()).toEqual("Installed");
  });

  // Disabling a node does not delete what it reported, so the rows outlive the
  // node's membership of the fleet.
  it("does not report Installed off the back of a node that is no longer in the fleet", async () => {
    await addNode("node-1");
    await addNode("node-2", "Online", false);
    await request();
    await observe("node-2");

    // node-2 is disabled: nothing that can run a match has the plugin.
    expect(await state()).toEqual("Pending");
  });

  it("does not stay Failed because of a decommissioned node", async () => {
    await addNode("node-1");
    await addNode("node-2", "Online", false);
    await request();
    await observe("node-1");
    await observe("node-2", { detected: false, status: "Failed" });

    expect(await state()).toEqual("Installed");
  });

  it("never counts more installed nodes than there are nodes to install on", async () => {
    await addNode("node-1");
    await addNode("node-2", "Offline");
    await request();
    await observe("node-1");
    await observe("node-2");

    const [row] = await postgres.query<
      Array<{ installed: number; target: number }>
    >(
      `SELECT game_plugin_installed_node_count(p.*) AS installed,
              game_plugin_target_node_count(p.*) AS target
         FROM game_plugins p WHERE slug = 'retakes'`,
    );

    expect(Number(row.installed)).toEqual(1);
    expect(Number(row.target)).toEqual(1);
  });

  it("counts installed and target nodes for the panel", async () => {
    await addNode("node-1");
    await addNode("node-2");
    await request();
    await observe("node-1");

    const [row] = await postgres.query<
      Array<{ installed: number; target: number }>
    >(
      `SELECT game_plugin_installed_node_count(p.*) AS installed,
              game_plugin_target_node_count(p.*) AS target
         FROM game_plugins p WHERE slug = 'retakes'`,
    );

    expect(Number(row.installed)).toEqual(1);
    expect(Number(row.target)).toEqual(2);
  });

  // An auto update overwrites the version the moment the node says it is
  // downloading, so the version it came from has to be carried on the report
  // or it is gone.
  describe("recorded progress", () => {
    const service = () =>
      new GamePluginsService(
        { warn: jest.fn(), log: jest.fn() } as never,
        {} as never,
        postgres,
        {} as never,
        {} as never,
        { add: jest.fn() } as never,
      );

    const row = async () => {
      const [record] = await postgres.query<Array<Record<string, any>>>(
        `SELECT version, previous_version, status, installed_at
           FROM game_server_node_plugins
          WHERE game_server_node_id = 'node-1' AND plugin_slug = 'retakes'`,
      );
      return record;
    };

    it("keeps the version an update replaced", async () => {
      await addNode("node-1");
      await request();

      await service().recordNodeProgress("node-1", {
        slug: "retakes",
        status: "Installed",
        version: "1.2.0",
        previousVersion: "1.1.0",
      });

      expect(await row()).toEqual(
        expect.objectContaining({
          version: "1.2.0",
          previous_version: "1.1.0",
        }),
      );
    });

    it("dates the install only once it lands", async () => {
      await addNode("node-1");
      await request();

      await service().recordNodeProgress("node-1", {
        slug: "retakes",
        status: "Installing",
        version: "1.2.0",
        previousVersion: "1.1.0",
      });

      expect((await row()).installed_at).toBeNull();

      await service().recordNodeProgress("node-1", {
        slug: "retakes",
        status: "Installed",
        version: "1.2.0",
        previousVersion: "1.1.0",
      });

      expect((await row()).installed_at).not.toBeNull();
    });

    // Reported once at the start of the install and not again on the failure,
    // which is the report that has to survive for the notice to say what the
    // node is still running.
    it("does not lose the previous version to a later report", async () => {
      await addNode("node-1");
      await request();

      await service().recordNodeProgress("node-1", {
        slug: "retakes",
        status: "Installing",
        version: "1.2.0",
        previousVersion: "1.1.0",
      });

      await service().recordNodeProgress("node-1", {
        slug: "retakes",
        status: "Failed",
        version: "1.2.0",
        error: "digest mismatch",
      });

      expect(await row()).toEqual(
        expect.objectContaining({
          status: "Failed",
          previous_version: "1.1.0",
        }),
      );
    });
  });

  // The catalog cannot say where a csgo-layout release lands, so the node
  // reports it and the panel opens that rather than a guessed configs folder.
  it("records where the node says the plugin lives", async () => {
    const service = new GamePluginsService(
      { warn: jest.fn(), log: jest.fn() } as never,
      {} as never,
      postgres,
      {} as never,
      {} as never,
      { add: jest.fn() } as never,
    );
    await addNode("node-1");
    await request();

    await service.recordNodeState("node-1", [
      {
        slug: "retakes",
        version: "1.0.0",
        runtime: "swiftlys2",
        source: "managed",
        path: "addons/swiftlys2/plugins/Retakes",
      },
    ]);

    const read = async () => {
      const [row] = await postgres.query<Array<{ path: string | null }>>(
        `SELECT path FROM game_server_node_plugins WHERE game_server_node_id = 'node-1'`,
      );
      return row.path;
    };

    expect(await read()).toEqual("addons/swiftlys2/plugins/Retakes");

    await service.recordNodeState("node-1", [
      {
        slug: "retakes",
        version: "1.0.0",
        runtime: "swiftlys2",
        source: "managed",
        path: null,
      },
    ]);

    expect(await read()).toBeNull();
  });
});
