import { PoolClient } from "pg";
import { PostgresController } from "../src/postgres/postgres.controller";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("database page query detail", () => {
  let db: SqlTestDb;
  let controller: PostgresController;
  let pool: { connect(): Promise<PoolClient> };

  beforeAll(async () => {
    db = await bootMigratedDb("QueryDetailExplainTest");
    controller = new PostgresController(db.postgres);
    pool = (db.postgres as unknown as { pool: typeof pool }).pool;
    await db.postgres.query(
      "CREATE TABLE public.query_detail_probe (id int PRIMARY KEY)",
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.postgres.query("TRUNCATE public.query_detail_probe");
    await db.postgres.query(
      "INSERT INTO public.query_detail_probe SELECT generate_series(1, 3)",
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Runs sql once so pg_stat_statements has an entry for it, undoes it with
  // cleanup, then opens the entry's detail. Suites that re-apply migrations
  // reset pg_stat_statements for the whole cluster, so a reset landing in
  // between is retried rather than failing the test.
  const detailOf = async (sql: string, cleanup: string) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await pool.connect();
      try {
        await client.query(sql);
        await client.query(cleanup);
      } finally {
        client.release(true);
      }
      const [row] = await db.postgres.query<Array<{ queryid: string }>>(
        "SELECT queryid::text FROM pg_stat_statements WHERE query = $1 AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())",
        [sql],
      );
      const detail = row && (await controller.getQueryDetail(row));
      if (detail) {
        return detail;
      }
    }
    throw new Error(`no pg_stat_statements entry for ${sql}`);
  };

  const probeRows = async () =>
    Number(
      (
        await db.postgres.query<Array<{ count: string }>>(
          "SELECT count(*) FROM public.query_detail_probe",
        )
      )[0].count,
    );

  it("never runs a DML entry for real, even when other traffic takes the connection in between", async () => {
    // Under load the pooled connection a statement ran on goes straight back
    // to someone else. Taking it the moment BEGIN returns makes that happen
    // every time instead of only on a busy panel.
    const query = db.postgres.query.bind(db.postgres);
    const held: Array<PoolClient> = [];
    jest
      .spyOn(db.postgres, "query")
      .mockImplementation(async (sql: string, ...rest: Array<any>) => {
        const result = await query(sql, ...rest);
        if (sql.trim() === "BEGIN") {
          held.push(await pool.connect());
        }
        return result as any;
      });

    const detail = await detailOf(
      "DELETE FROM public.query_detail_probe",
      "INSERT INTO public.query_detail_probe SELECT generate_series(1, 3)",
    );

    for (const client of held) {
      await client.query("ROLLBACK");
      client.release();
    }
    jest.restoreAllMocks();

    expect(await probeRows()).toBe(3);
    expect(detail.explain_plan).toBeTruthy();
    expect(JSON.parse(detail.explain_plan!)[0]["Execution Time"]).toBe(
      undefined,
    );
  });

  // EXPLAIN counts as read-only, so READ ONLY on its own lets the CREATE
  // under EXPLAIN ANALYZE run; only never committing undoes it.
  it("keeps nothing a CREATE TABLE AS entry builds", async () => {
    await detailOf(
      "CREATE TABLE public.query_detail_copy AS SELECT * FROM public.query_detail_probe",
      "DROP TABLE public.query_detail_copy",
    );

    const [row] = await db.postgres.query<Array<{ copy: string | null }>>(
      "SELECT to_regclass('public.query_detail_copy')::text AS copy",
    );
    expect(row.copy).toBeNull();
  });

  it("leaves no session-level lock behind on a pooled connection", async () => {
    await detailOf(
      "SELECT pg_advisory_lock(id) FROM public.query_detail_probe",
      "SELECT pg_advisory_unlock_all()",
    );

    // A destroyed connection's backend exits a moment after the client lets go.
    let held = -1;
    for (let attempt = 0; attempt < 40 && held !== 0; attempt++) {
      const [row] = await db.postgres.query<Array<{ count: string }>>(
        `SELECT count(*) FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      held = Number(row.count);
      if (held !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(held).toBe(0);
  });

  it("still gives a SELECT entry its actual execution stats", async () => {
    const detail = await detailOf(
      "SELECT count(*) FROM public.query_detail_probe",
      "SELECT 1",
    );

    const [plan] = JSON.parse(detail.explain_plan!);
    expect(plan["Execution Time"]).toEqual(expect.any(Number));
    expect(plan.Plan["Actual Rows"]).toBe(1);
  });
});
