import { PoolClient } from "pg";
import { PostgresController } from "../src/postgres/postgres.controller";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("database page query detail", () => {
  let db: SqlTestDb;
  let controller: PostgresController;

  beforeAll(async () => {
    db = await bootMigratedDb("QueryDetailExplainTest");
    controller = new PostgresController(db.postgres);
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

  const queryIdOf = async (sql: string) => {
    await db.postgres.query(sql);
    const [row] = await db.postgres.query<Array<{ queryid: string }>>(
      "SELECT queryid::text FROM pg_stat_statements WHERE query = $1 AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())",
      [sql],
    );
    return row.queryid;
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
    const queryid = await queryIdOf("DELETE FROM public.query_detail_probe");
    await db.postgres.query(
      "INSERT INTO public.query_detail_probe SELECT generate_series(1, 3)",
    );

    // Under load the pooled connection a statement ran on goes straight back
    // to someone else. Taking it the moment BEGIN returns makes that happen
    // every time instead of only on a busy panel.
    const pool = (db.postgres as unknown as { pool: any }).pool;
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

    const detail = await controller.getQueryDetail({ queryid });

    for (const client of held) {
      await client.query("ROLLBACK");
      client.release();
    }
    jest.restoreAllMocks();

    expect(await probeRows()).toBe(3);
    expect(detail?.explain_plan).toBeTruthy();
    expect(JSON.parse(detail!.explain_plan!)[0]["Execution Time"]).toBe(
      undefined,
    );
  });

  it("still gives a SELECT entry its actual execution stats", async () => {
    const queryid = await queryIdOf(
      "SELECT count(*) FROM public.query_detail_probe",
    );

    const detail = await controller.getQueryDetail({ queryid });

    const [plan] = JSON.parse(detail!.explain_plan!);
    expect(plan["Execution Time"]).toEqual(expect.any(Number));
    expect(plan.Plan["Actual Rows"]).toBe(1);
  });
});
