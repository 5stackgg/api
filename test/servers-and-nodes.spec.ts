import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Exercises the game-server-node / servers SQL: on-demand server population
// across a node's port range, dedicated servers taking over (and releasing)
// node slots, rcon password encryption, and the guards on node servers.
describe("servers and game server nodes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let nodeSeq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("ServersNodesTest");
    postgres = db.postgres;
    await postgres.query(
      `INSERT INTO server_regions (value, description) VALUES ('NodeRegion', 'NodeRegion')
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

  // A node whose port range yields five paired game/tv ports.
  const createNode = async () => {
    const id = `test-node-${++nodeSeq}`;
    await postgres.query(
      `INSERT INTO game_server_nodes (id, public_ip, start_port_range, end_port_range, region, status, enabled, label)
       VALUES ($1, '203.0.113.1', 27015, 27025, 'NodeRegion', 'Online', true, $1)`,
      [id],
    );
    return id;
  };

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
