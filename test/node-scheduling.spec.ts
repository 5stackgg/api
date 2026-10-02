import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { GameServerNodeService } from "./../src/game-server-node/game-server-node.service";
import { GameServerNodeController } from "./../src/game-server-node/game-server-node.controller";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// "Accepting new matches" used to live only in status, which the offline job
// overwrites with Offline: a node told to stop taking matches came back from any
// outage taking them again, and toggling a node that was down marked it Online.
describe("node scheduling across an outage (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let nodes: GameServerNodeService;
  let controller: GameServerNodeController;

  beforeAll(async () => {
    db = await bootMigratedDb("NodeSchedulingTest");
    postgres = db.postgres;
    await postgres.query(
      `INSERT INTO server_regions (value, description) VALUES ('SchedRegion', 'SchedRegion')
       ON CONFLICT (value) DO NOTHING`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  // No GraphQL engine runs here, so node reads come straight from the table and
  // only the status columns of a node update are written back; that is all
  // these paths change.
  const hasura = {
    query: async (query: Record<string, any>) => {
      const [row] = await postgres.query<Array<Record<string, unknown>>>(
        `SELECT * FROM game_server_nodes WHERE id = $1`,
        [query.game_server_nodes_by_pk.__args.id],
      );
      const servers: Array<{ id: string }> = [];
      return { game_server_nodes_by_pk: row ? { ...row, servers } : null };
    },
    mutation: async (mutation: Record<string, any>) => {
      const byPk = mutation.update_game_server_nodes_by_pk;
      const bulk = mutation.update_game_server_nodes;
      const args = byPk?.__args ?? bulk?.__args;
      if (!args) {
        return {};
      }

      const id = byPk ? args.pk_columns.id : args.where.id._eq;
      const onlyFrom: Array<string> | null = bulk
        ? (args.where.status?._in ?? null)
        : null;
      const set = Object.entries(args._set).filter(([column]) =>
        ["status", "offline_at"].includes(column),
      );
      if (set.length === 0) {
        return { update_game_server_nodes: { affected_rows: 0 } };
      }

      const updated = await postgres.query<Array<{ id: string }>>(
        `UPDATE game_server_nodes
            SET ${set.map(([column], index) => `${column} = $${index + 3}`).join(", ")}
          WHERE id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          RETURNING id`,
        [id, onlyFrom, ...set.map(([, value]) => value)],
      );
      return { update_game_server_nodes: { affected_rows: updated.length } };
    },
  };

  beforeEach(async () => {
    await postgres.query("DELETE FROM servers");
    await postgres.query("DELETE FROM game_server_nodes");
    await postgres.query(
      `INSERT INTO game_server_nodes (id, region, status, enabled, label)
       VALUES ('sched-node', 'SchedRegion', 'Online', true, 'sched-node')`,
    );

    nodes = new GameServerNodeService(
      new Logger("NodeSchedulingTest"),
      { get: () => ({ namespace: "5stack" }) } as never,
      hasura as never,
      { getConnection: () => ({}) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      postgres,
      {} as never,
    );

    controller = new GameServerNodeController(
      new Logger("NodeSchedulingTest"),
      {} as never,
      { get: () => ({}) } as never,
      hasura as never,
      {} as never,
      {} as never,
      {} as never,
      nodes,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  const status = async () => {
    const [row] = await postgres.query<Array<{ status: string }>>(
      `SELECT status FROM game_server_nodes WHERE id = 'sched-node'`,
    );
    return row.status;
  };

  const goOffline = () =>
    postgres.query(
      `UPDATE game_server_nodes SET status = 'Offline', offline_at = now()
        WHERE id = 'sched-node'`,
    );

  const ping = () =>
    nodes.updateStatus(
      "sched-node",
      "10.0.0.2",
      "10.0.0.2",
      "203.0.113.2",
      undefined,
      undefined,
      false,
      false,
      { sockets: 1, coresPerSocket: 4, threadsPerCore: 2 } as never,
      { governor: "performance", cpus: {} },
      { frequency: 0, cpus: {} },
      { count: 0, devices: null },
      "Online",
    );

  const schedule = (enabled: boolean) =>
    controller.setGameNodeSchedulingState({
      game_server_node_id: "sched-node",
      enabled,
    });

  it("stops and resumes taking matches on a node that is up", async () => {
    await schedule(false);
    expect(await status()).toBe("NotAcceptingNewMatches");

    await schedule(true);
    expect(await status()).toBe("Online");
  });

  it("brings a node that was not accepting matches back the same way", async () => {
    await schedule(false);
    await goOffline();

    const result = await ping();

    expect(result?.transitionedFromOffline).toBe(true);
    expect(await status()).toBe("NotAcceptingNewMatches");
  });

  it("brings an accepting node back Online", async () => {
    await goOffline();

    await ping();

    expect(await status()).toBe("Online");
  });

  it("does not mark a node that is down Online when scheduling is turned on", async () => {
    await schedule(false);
    await goOffline();

    await schedule(true);

    expect(await status()).toBe("Offline");
    await ping();
    expect(await status()).toBe("Online");
  });

  it("leaves a node still in setup alone", async () => {
    await postgres.query(
      `UPDATE game_server_nodes SET status = 'Setup' WHERE id = 'sched-node'`,
    );

    expect(await schedule(false)).toEqual({ success: false });
    expect(await status()).toBe("Setup");
  });
});
