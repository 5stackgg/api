import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Exercises the game-server-node / servers SQL: on-demand server population
// across a node's port range, dedicated servers taking over (and releasing)
// node slots, rcon password encryption, and the guards on node servers.
describe("servers and game server nodes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let nodeSeq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("ServersNodesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561192830000000n);
    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('NodeRegion', 'NodeRegion', false), ('OtherRegion', 'OtherRegion', false), ('LanRegion', 'LanRegion', true)
       ON CONFLICT (value) DO NOTHING`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM servers");
    await postgres.query("DELETE FROM game_server_nodes");
  });

  // A node whose port range yields five paired game/tv ports unless told fewer.
  const createNode = async (
    options: {
      startPort?: number;
      slots?: number;
      ip?: string;
      region?: string;
    } = {},
  ) => {
    const id = `test-node-${++nodeSeq}`;
    const startPort = options.startPort ?? 27015;
    await postgres.query(
      `INSERT INTO game_server_nodes (id, public_ip, start_port_range, end_port_range, region, status, enabled, label)
       VALUES ($1, $2, $3, $4, $5, 'Online', true, $1)`,
      [
        id,
        options.ip ?? "203.0.113.1",
        startPort,
        startPort + (options.slots ?? 5) * 2,
        options.region ?? "NodeRegion",
      ],
    );
    return id;
  };

  const createDedicatedServer = async (nodeId: string) => {
    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers (host, label, rcon_password, port, tv_port, region, type, is_dedicated, enabled, game_server_node_id)
       VALUES ('203.0.113.1', 'dedicated', $1, 28000, 28001, 'NodeRegion', 'Casual', true, true, $2)
       RETURNING id`,
      [Buffer.from("secret"), nodeId],
    );
    return server.id;
  };

  // One statement deleting several servers visits them in disk order. The
  // lowest id, clustered on the primary key, puts the dedicated server ahead
  // of the on-demand server whose slot it took.
  const createDedicatedServerFirstOnDisk = async (nodeId: string) => {
    await postgres.query(
      `INSERT INTO servers (id, host, label, rcon_password, port, tv_port, region, type, is_dedicated, enabled, game_server_node_id)
       VALUES ('00000000-0000-0000-0000-000000000001', '203.0.113.1', 'dedicated', $1, 28000, 28001, 'NodeRegion', 'Casual', true, true, $2)`,
      [Buffer.from("secret"), nodeId],
    );
    await postgres.query("CLUSTER servers USING servers_pkey");
  };

  const dedicatedServer = async (id: string) => {
    const [server] = await postgres.query<
      Array<{
        game_server_node_id: string;
        host: string;
        port: number;
        tv_port: number;
        region: string;
      }>
    >(
      "SELECT game_server_node_id, host, port, tv_port, region FROM servers WHERE id = $1",
      [id],
    );
    return {
      ...server,
      port: Number(server.port),
      tv_port: Number(server.tv_port),
    };
  };

  const slotEnabled = async (nodeId: string, port: number) =>
    (await nodeServers(nodeId)).find((s) => Number(s.port) === port)!.enabled;

  const nodeServers = (nodeId: string) =>
    postgres.query<
      Array<{
        label: string;
        port: number;
        tv_port: number;
        enabled: boolean;
        is_dedicated: boolean;
      }>
    >(
      `SELECT label, port, tv_port, enabled, is_dedicated FROM servers
       WHERE game_server_node_id = $1 AND is_dedicated = false ORDER BY port`,
      [nodeId],
    );

  const slotStates = async (nodeId: string) =>
    (await nodeServers(nodeId)).map((s) => [Number(s.port), s.enabled]);

  const setPortRange = (nodeId: string, startPort: number, slots: number) =>
    postgres.query(
      "UPDATE game_server_nodes SET start_port_range = $2, end_port_range = $3 WHERE id = $1",
      [nodeId, startPort, startPort + slots * 2],
    );

  it("creating a node populates on-demand servers across its port range", async () => {
    const nodeId = await createNode();

    const servers = await nodeServers(nodeId);
    expect(servers.length).toBe(5);
    expect(servers.map((s) => [Number(s.port), Number(s.tv_port)])).toEqual([
      [27015, 27016],
      [27017, 27018],
      [27019, 27020],
      [27021, 27022],
      [27023, 27024],
    ]);
    expect(servers.every((s) => s.enabled)).toBe(true);
  });

  it("a dedicated server claims the lowest node slot and releases it on delete", async () => {
    const nodeId = await createNode();

    const [dedicated] = await postgres.query<
      Array<{ id: string; port: number; tv_port: number }>
    >(
      `INSERT INTO servers (host, label, rcon_password, port, tv_port, region, type, is_dedicated, enabled, game_server_node_id)
       VALUES ('203.0.113.1', 'dedicated', $1, 28000, 28001, 'NodeRegion', 'Ranked', true, true, $2)
       RETURNING id, port, tv_port`,
      [Buffer.from("secret"), nodeId],
    );
    // The requested port is ignored: the trigger assigns the claimed slot's ports.
    expect(Number(dedicated.port)).toBe(27015);
    expect(Number(dedicated.tv_port)).toBe(27016);

    let servers = await nodeServers(nodeId);
    expect(servers.find((s) => Number(s.port) === 27015)!.enabled).toBe(false);
    expect(servers.filter((s) => s.enabled).length).toBe(4);

    await postgres.query("DELETE FROM servers WHERE id = $1", [dedicated.id]);
    servers = await nodeServers(nodeId);
    expect(servers.every((s) => s.enabled)).toBe(true);
  });

  it("moving a dedicated server to another node claims a slot there and frees the old one", async () => {
    const from = await createNode();
    const to = await createNode({
      startPort: 27115,
      ip: "203.0.113.2",
      region: "OtherRegion",
    });
    const serverId = await createDedicatedServer(from);

    await postgres.query(
      "UPDATE servers SET game_server_node_id = $1 WHERE id = $2",
      [to, serverId],
    );

    expect(await dedicatedServer(serverId)).toEqual({
      game_server_node_id: to,
      host: "203.0.113.2",
      port: 27115,
      tv_port: 27116,
      region: "OtherRegion",
    });
    expect(await slotEnabled(from, 27015)).toBe(true);
    expect(await slotEnabled(to, 27115)).toBe(false);
  });

  it("a disabled dedicated server leaves its slot to on-demand matches, wherever it is moved", async () => {
    const from = await createNode();
    const to = await createNode({ startPort: 27115, ip: "203.0.113.2" });
    const serverId = await createDedicatedServer(from);
    await postgres.query("UPDATE servers SET enabled = false WHERE id = $1", [
      serverId,
    ]);
    expect(await slotEnabled(from, 27015)).toBe(true);

    await postgres.query(
      "UPDATE servers SET game_server_node_id = $1 WHERE id = $2",
      [to, serverId],
    );

    expect(await dedicatedServer(serverId)).toMatchObject({ port: 27115 });
    expect(await slotEnabled(to, 27115)).toBe(true);

    await postgres.query("UPDATE servers SET enabled = true WHERE id = $1", [
      serverId,
    ]);
    expect(await slotEnabled(to, 27115)).toBe(false);
  });

  it("a dedicated server staying on its node still cannot change its ports", async () => {
    const nodeId = await createNode();
    const serverId = await createDedicatedServer(nodeId);

    await expect(
      postgres.query("UPDATE servers SET port = 27017 WHERE id = $1", [
        serverId,
      ]),
    ).rejects.toThrow(/Cannot change the port or tv_port/i);
  });

  it("moving to a node with no free slot is refused and leaves the server where it was", async () => {
    const from = await createNode();
    const to = await createNode({ startPort: 27115, ip: "203.0.113.2" });
    const serverId = await createDedicatedServer(from);
    await postgres.query(
      "UPDATE servers SET enabled = false WHERE game_server_node_id = $1 AND is_dedicated = false",
      [to],
    );

    await expect(
      postgres.query(
        "UPDATE servers SET game_server_node_id = $1 WHERE id = $2",
        [to, serverId],
      ),
    ).rejects.toThrow(/No available game node server/i);

    expect(await dedicatedServer(serverId)).toMatchObject({
      game_server_node_id: from,
      port: 27015,
    });
    expect(await slotEnabled(from, 27015)).toBe(false);
  });

  it("counts the slots a dedicated server moving onto a node could take", async () => {
    const count = async (nodeId: string) => {
      const [row] = await postgres.query<Array<{ c: number }>>(
        "SELECT available_dedicated_slot_count(n) AS c FROM game_server_nodes n WHERE id = $1",
        [nodeId],
      );
      return Number(row.c);
    };

    const nodeId = await createNode();
    expect(await count(nodeId)).toBe(5);

    await createDedicatedServer(nodeId);
    expect(await count(nodeId)).toBe(4);

    await postgres.query(
      "UPDATE servers SET enabled = false WHERE game_server_node_id = $1 AND port = 27017",
      [nodeId],
    );
    expect(await count(nodeId)).toBe(3);
  });

  describe("a node's changes reach its dedicated servers", () => {
    it("seats a dedicated server on the new range's lowest pair when the range moves away from it", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);

      await setPortRange(nodeId, 27115, 3);

      expect(await dedicatedServer(serverId)).toMatchObject({
        port: 27115,
        tv_port: 27116,
      });
      expect(await slotStates(nodeId)).toEqual([
        [27115, false],
        [27117, true],
        [27119, true],
      ]);
    });

    it("seats several dedicated servers in port order, each on its own pair", async () => {
      const nodeId = await createNode();
      const replaced = await createDedicatedServer(nodeId);
      const second = await createDedicatedServer(nodeId);
      // Created last, yet on the lowest port.
      await postgres.query("DELETE FROM servers WHERE id = $1", [replaced]);
      const first = await createDedicatedServer(nodeId);

      await setPortRange(nodeId, 27115, 3);

      expect(await dedicatedServer(first)).toMatchObject({
        port: 27115,
        tv_port: 27116,
      });
      expect(await dedicatedServer(second)).toMatchObject({
        port: 27117,
        tv_port: 27118,
      });
      expect(await slotStates(nodeId)).toEqual([
        [27115, false],
        [27117, false],
        [27119, true],
      ]);
    });

    it("seats a moved dedicated server past the pair another one keeps", async () => {
      const nodeId = await createNode();
      const moved = await createDedicatedServer(nodeId);
      const kept = await createDedicatedServer(nodeId);

      await setPortRange(nodeId, 27017, 3);

      expect(await dedicatedServer(kept)).toMatchObject({
        port: 27017,
        tv_port: 27018,
      });
      expect(await dedicatedServer(moved)).toMatchObject({
        port: 27019,
        tv_port: 27020,
      });
      expect(await slotStates(nodeId)).toEqual([
        [27017, false],
        [27019, false],
        [27021, true],
      ]);
    });

    it("leaves a moved dedicated server's pair usable while that server is disabled", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);
      await postgres.query("UPDATE servers SET enabled = false WHERE id = $1", [
        serverId,
      ]);

      await setPortRange(nodeId, 27115, 2);

      expect(await dedicatedServer(serverId)).toMatchObject({ port: 27115 });
      expect(await slotStates(nodeId)).toEqual([
        [27115, true],
        [27117, true],
      ]);
    });

    it("keeps a dedicated server on its ports while they are still a pair of the range", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);

      await setPortRange(nodeId, 27015, 8);

      expect(await dedicatedServer(serverId)).toMatchObject({
        port: 27015,
        tv_port: 27016,
      });
      expect(await slotEnabled(nodeId, 27015)).toBe(false);

      await setPortRange(nodeId, 27011, 5);

      expect(await dedicatedServer(serverId)).toMatchObject({
        port: 27015,
        tv_port: 27016,
      });
      expect(await slotStates(nodeId)).toEqual([
        [27011, true],
        [27013, true],
        [27015, false],
        [27017, true],
        [27019, true],
      ]);
    });

    it("re-seats a dedicated server an odd shift left across two pairs, so deleting it frees its slot", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);

      await setPortRange(nodeId, 27014, 5);

      expect(await dedicatedServer(serverId)).toMatchObject({
        port: 27014,
        tv_port: 27015,
      });
      expect(await slotStates(nodeId)).toEqual([
        [27014, false],
        [27016, true],
        [27018, true],
        [27020, true],
        [27022, true],
      ]);

      await postgres.query("DELETE FROM servers WHERE id = $1", [serverId]);

      expect((await nodeServers(nodeId)).every((s) => s.enabled)).toBe(true);
    });

    it("refuses a port range with no room for the node's dedicated servers and changes nothing", async () => {
      const nodeId = await createNode({ slots: 2 });
      const first = await createDedicatedServer(nodeId);
      const second = await createDedicatedServer(nodeId);

      const unchanged = async () => {
        const [node] = await postgres.query<
          Array<{ start_port_range: number; end_port_range: number }>
        >(
          "SELECT start_port_range, end_port_range FROM game_server_nodes WHERE id = $1",
          [nodeId],
        );
        expect([
          Number(node.start_port_range),
          Number(node.end_port_range),
        ]).toEqual([27015, 27019]);
        expect(await dedicatedServer(first)).toMatchObject({
          port: 27015,
          tv_port: 27016,
        });
        expect(await dedicatedServer(second)).toMatchObject({
          port: 27017,
          tv_port: 27018,
        });
        expect(await slotStates(nodeId)).toEqual([
          [27015, false],
          [27017, false],
        ]);
      };

      await expect(setPortRange(nodeId, 27015, 1)).rejects.toThrow(
        /no room for the dedicated servers/i,
      );
      await unchanged();

      await expect(setPortRange(nodeId, 27115, 1)).rejects.toThrow(
        /no room for the dedicated servers/i,
      );
      await unchanged();
    });

    it("carries the node's new IP to a dedicated server's host", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);

      await postgres.query(
        "UPDATE game_server_nodes SET public_ip = '203.0.113.50' WHERE id = $1",
        [nodeId],
      );

      expect(await dedicatedServer(serverId)).toMatchObject({
        host: "203.0.113.50",
        port: 27015,
      });
    });

    it("carries the node's new region to a dedicated server", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);

      await postgres.query(
        "UPDATE game_server_nodes SET region = 'OtherRegion' WHERE id = $1",
        [nodeId],
      );

      expect(await dedicatedServer(serverId)).toEqual({
        game_server_node_id: nodeId,
        host: "203.0.113.1",
        port: 27015,
        tv_port: 27016,
        region: "OtherRegion",
      });
      expect(await slotEnabled(nodeId, 27015)).toBe(false);
    });

    it("re-addresses a dedicated server when its node moves between an online and a LAN region", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);
      await postgres.query(
        "UPDATE game_server_nodes SET lan_ip = '10.0.0.5' WHERE id = $1",
        [nodeId],
      );

      await postgres.query(
        "UPDATE game_server_nodes SET region = 'LanRegion' WHERE id = $1",
        [nodeId],
      );

      expect(await dedicatedServer(serverId)).toMatchObject({
        host: "10.0.0.5",
        region: "LanRegion",
      });

      await postgres.query(
        "UPDATE game_server_nodes SET region = 'NodeRegion' WHERE id = $1",
        [nodeId],
      );

      expect(await dedicatedServer(serverId)).toMatchObject({
        host: "203.0.113.1",
        region: "NodeRegion",
      });
    });

    it("re-addresses a dedicated server when its region is switched to LAN and back", async () => {
      await postgres.query(
        `INSERT INTO server_regions (value, description, is_lan) VALUES ('FlipRegion', 'FlipRegion', false)
         ON CONFLICT (value) DO UPDATE SET is_lan = false`,
      );
      const nodeId = await createNode({ region: "FlipRegion" });
      await postgres.query(
        "UPDATE game_server_nodes SET lan_ip = '10.0.0.5' WHERE id = $1",
        [nodeId],
      );
      const serverId = await createDedicatedServer(nodeId);

      await postgres.query(
        "UPDATE server_regions SET is_lan = true WHERE value = 'FlipRegion'",
      );

      expect(await dedicatedServer(serverId)).toMatchObject({
        host: "10.0.0.5",
        region: "FlipRegion",
      });

      await postgres.query(
        "UPDATE server_regions SET is_lan = false WHERE value = 'FlipRegion'",
      );

      expect(await dedicatedServer(serverId)).toMatchObject({
        host: "203.0.113.1",
        region: "FlipRegion",
      });
    });

    it("leaves a dedicated server on a LAN region alone when only the node's public IP changes", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);
      await postgres.query(
        "UPDATE game_server_nodes SET lan_ip = '10.0.0.5' WHERE id = $1",
        [nodeId],
      );
      await postgres.query(
        "UPDATE game_server_nodes SET region = 'LanRegion' WHERE id = $1",
        [nodeId],
      );
      const updatedAt = () =>
        postgres.query<Array<{ host: string; updated_at: Date }>>(
          "SELECT host, updated_at FROM servers WHERE id = $1",
          [serverId],
        );
      const before = await updatedAt();
      expect(before[0].host).toBe("10.0.0.5");

      await postgres.query(
        "UPDATE game_server_nodes SET public_ip = '203.0.113.50' WHERE id = $1",
        [nodeId],
      );

      expect(await updatedAt()).toEqual(before);
    });

    it("still refuses a direct port, host or region edit, even in the transaction that re-seated the server", async () => {
      const nodeId = await createNode();
      const serverId = await createDedicatedServer(nodeId);
      const seated = {
        game_server_node_id: nodeId,
        host: "203.0.113.50",
        port: 27115,
        tv_port: 27116,
        region: "NodeRegion",
      };

      const refusal = await postgres.transaction(async (client) => {
        await client.query(
          `UPDATE game_server_nodes
           SET public_ip = '203.0.113.50', start_port_range = 27115, end_port_range = 27121
           WHERE id = $1`,
          [nodeId],
        );
        await client.query(
          "UPDATE servers SET host = '198.51.100.9', region = 'OtherRegion' WHERE id = $1",
          [serverId],
        );
        await client.query("SAVEPOINT direct_edit");
        try {
          await client.query(
            "UPDATE servers SET port = 27117, tv_port = 27118 WHERE id = $1",
            [serverId],
          );
          return null;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT direct_edit");
          return error as Error;
        }
      });

      expect(refusal?.message).toMatch(/Cannot change the port or tv_port/i);
      expect(await dedicatedServer(serverId)).toEqual(seated);

      await postgres.query(
        "UPDATE servers SET host = '198.51.100.9', region = 'OtherRegion' WHERE id = $1",
        [serverId],
      );
      await expect(
        postgres.query(
          "UPDATE servers SET port = 27117, tv_port = 27118 WHERE id = $1",
          [serverId],
        ),
      ).rejects.toThrow(/Cannot change the port or tv_port/i);
      expect(await dedicatedServer(serverId)).toEqual(seated);
    });
  });

  describe("server moves", () => {
    const insertMove = (serverId: string, status = "Queued") =>
      postgres.query(
        "INSERT INTO server_migrations (server_id, status) VALUES ($1, $2)",
        [serverId, status],
      );

    it("allows only one move in flight per server", async () => {
      const serverId = await createDedicatedServer(await createNode());

      await insertMove(serverId, "Transferring");

      await expect(insertMove(serverId)).rejects.toMatchObject({
        code: "23505",
      });
    });

    it("allows a new move once the last one has finished", async () => {
      const serverId = await createDedicatedServer(await createNode());

      await insertMove(serverId, "Completed");
      await insertMove(serverId, "Failed");
      await insertMove(serverId, "Canceled");

      await expect(insertMove(serverId)).resolves.toBeDefined();
    });

    it("refuses a status that is not a move status", async () => {
      const serverId = await createDedicatedServer(await createNode());

      await expect(insertMove(serverId, "Paused")).rejects.toThrow(
        /server_migrations_status_fkey/,
      );
    });

    it("goes away with the server", async () => {
      const serverId = await createDedicatedServer(await createNode());
      await insertMove(serverId, "Completed");

      await postgres.query("DELETE FROM servers WHERE id = $1", [serverId]);

      const moves = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM server_migrations WHERE server_id = $1",
        [serverId],
      );
      expect(moves.length).toBe(0);
    });
  });

  it("encrypts rcon passwords at rest and re-encrypts on change", async () => {
    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled)
       VALUES ('203.0.113.9', 'standalone', $1, 27100, 'NodeRegion', 'Ranked', true, true)
       RETURNING id`,
      [Buffer.from("first-secret")],
    );

    const decrypt = async () => {
      const [row] = await postgres.query<Array<{ plain: string }>>(
        `SELECT convert_from(pgp_sym_decrypt_bytea(rcon_password, 'test-app-key'), 'utf8') AS plain
         FROM servers WHERE id = $1`,
        [server.id],
      );
      return row.plain;
    };

    expect(await decrypt()).toBe("first-secret");
    const [{ raw }] = await postgres.query<Array<{ raw: string }>>(
      "SELECT rcon_password::text AS raw FROM servers WHERE id = $1",
      [server.id],
    );
    expect(raw).not.toContain("first-secret");

    await postgres.query(
      "UPDATE servers SET rcon_password = $1 WHERE id = $2",
      [Buffer.from("second-secret"), server.id],
    );
    expect(await decrypt()).toBe("second-secret");
  });

  it("guards node servers: no type change, no node removal, no orphan node servers", async () => {
    const nodeId = await createNode();

    await expect(
      postgres.query(
        `UPDATE servers SET type = 'Casual' WHERE game_server_node_id = $1 AND port = 27015`,
        [nodeId],
      ),
    ).rejects.toThrow(/Cannot change the type of a game node server/i);

    await expect(
      postgres.query(
        `UPDATE servers SET game_server_node_id = NULL WHERE game_server_node_id = $1 AND port = 27015`,
        [nodeId],
      ),
    ).rejects.toThrow(/Cannot remove from a game server node/i);

    await expect(
      postgres.query(
        `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled)
         VALUES ('203.0.113.9', 'orphan', $1, 27200, 'NodeRegion', 'Ranked', false, true)`,
        [Buffer.from("x")],
      ),
    ).rejects.toThrow(/without a node assigned/i);
  });

  it("deletes a dedicated server and the slot it took in one statement, whichever is first on disk", async () => {
    const nodeId = await createNode();
    await createDedicatedServerFirstOnDisk(nodeId);

    await postgres.query("DELETE FROM servers WHERE game_server_node_id = $1", [
      nodeId,
    ]);

    const servers = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM servers WHERE game_server_node_id = $1",
      [nodeId],
    );
    expect(servers.length).toBe(0);
  });

  it("deleting a node removes a dedicated server it hosts along with its slot", async () => {
    const nodeId = await createNode();
    await createDedicatedServerFirstOnDisk(nodeId);

    await postgres.query("DELETE FROM game_server_nodes WHERE id = $1", [
      nodeId,
    ]);

    const servers = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM servers",
    );
    expect(servers.length).toBe(0);
  });

  it("keeps a match on its region when the dedicated server it was pinned to is deleted, even on a one-slot region", async () => {
    const nodeId = await createNode({ region: "OtherRegion", slots: 1 });
    const serverId = await createDedicatedServer(nodeId);
    const match = await fx.match({ regions: ["OtherRegion"] });

    try {
      await postgres.query("UPDATE matches SET server_id = $1 WHERE id = $2", [
        serverId,
        match.id,
      ]);

      await postgres.query("DELETE FROM servers WHERE id = $1", [serverId]);

      const [options] = await postgres.query<Array<{ regions: string[] }>>(
        "SELECT regions FROM match_options WHERE id = $1",
        [match.options_id],
      );
      expect(options.regions).toEqual(["OtherRegion"]);
      expect(await slotEnabled(nodeId, 27015)).toBe(true);
    } finally {
      await postgres.query("DELETE FROM matches WHERE id = $1", [match.id]);
    }
  });

  it("deleting a node removes its on-demand servers", async () => {
    const nodeId = await createNode();
    await postgres.query("DELETE FROM game_server_nodes WHERE id = $1", [
      nodeId,
    ]);

    const servers = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM servers WHERE game_server_node_id = $1",
      [nodeId],
    );
    expect(servers.length).toBe(0);
  });

  it("region server counts follow enabled servers on healthy nodes", async () => {
    const count = async () => {
      const [row] = await postgres.query<Array<{ c: number }>>(
        `SELECT total_region_server_count(sr) AS c FROM server_regions sr WHERE value = 'NodeRegion'`,
      );
      return Number(row.c);
    };

    expect(await count()).toBe(0);
    const nodeId = await createNode();
    expect(await count()).toBe(5);

    await postgres.query(
      "UPDATE game_server_nodes SET enabled = false WHERE id = $1",
      [nodeId],
    );
    expect(await count()).toBe(0);
  });
});
