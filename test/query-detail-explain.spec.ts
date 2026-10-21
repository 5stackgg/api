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

  type Statement = { sql: string; values?: Array<unknown>; stored?: string };

  // Runs the statement once so pg_stat_statements has an entry for it, undoes
  // it with cleanup, then opens the entry. Suites that re-apply migrations
  // reset pg_stat_statements for the whole cluster, so a reset landing in
  // between is retried rather than failing the test.
  const withEntry = async <T>(
    statement: Statement,
    cleanup: string,
    open: (queryid: string) => Promise<T | null>,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await pool.connect();
      try {
        await client.query(statement.sql, statement.values);
        await client.query(cleanup);
      } finally {
        client.release(true);
      }
      const [row] = await db.postgres.query<Array<{ queryid: string }>>(
        "SELECT queryid::text FROM pg_stat_statements WHERE query = $1 AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())",
        [statement.stored ?? statement.sql],
      );
      const opened = row && (await open(row.queryid));
      if (opened) {
        return opened;
      }
    }
    throw new Error(`no pg_stat_statements entry for ${statement.sql}`);
  };

  const detailOf = (statement: Statement, cleanup = "SELECT 1") =>
    withEntry(statement, cleanup, (queryid) =>
      controller.getQueryDetail({ queryid }),
    );

  const analysisOf = (
    statement: Statement,
    parameters: Array<{ number: number; values: Array<string | null> }> = [],
    cleanup = "SELECT 1",
  ) =>
    withEntry(statement, cleanup, (queryid) =>
      controller.analyzeQuery({ queryid, parameters }).catch((error): null => {
        if (error.message === "query not found") {
          return null;
        }
        throw error;
      }),
    );

  const probeRows = async () =>
    Number(
      (
        await db.postgres.query<Array<{ count: string }>>(
          "SELECT count(*) FROM public.query_detail_probe",
        )
      )[0].count,
    );

  it("only plans a query when it is opened", async () => {
    const detail = await detailOf(
      { sql: "DELETE FROM public.query_detail_probe" },
      "INSERT INTO public.query_detail_probe SELECT generate_series(1, 3)",
    );

    expect(await probeRows()).toBe(3);
    expect(detail.explain_kind).toBe("estimate");
    expect(detail.parameters).toEqual([]);
    expect(JSON.parse(detail.explain_plan!)[0]["Execution Time"]).toBe(
      undefined,
    );
  });

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

    await expect(
      analysisOf(
        { sql: "DELETE FROM public.query_detail_probe" },
        [],
        "INSERT INTO public.query_detail_probe SELECT generate_series(1, 3)",
      ),
    ).rejects.toThrow("read-only transaction");

    for (const client of held) {
      await client.query("ROLLBACK");
      client.release();
    }
    jest.restoreAllMocks();

    expect(await probeRows()).toBe(3);
  });

  // EXPLAIN counts as read-only, so READ ONLY on its own lets the CREATE
  // under EXPLAIN ANALYZE run; only never committing undoes it.
  it("keeps nothing a CREATE TABLE AS entry builds", async () => {
    await analysisOf(
      {
        sql: "CREATE TABLE public.query_detail_copy AS SELECT * FROM public.query_detail_probe",
      },
      [],
      "DROP TABLE public.query_detail_copy",
    );

    const [row] = await db.postgres.query<Array<{ copy: string | null }>>(
      "SELECT to_regclass('public.query_detail_copy')::text AS copy",
    );
    expect(row.copy).toBeNull();
  });

  it("leaves no session-level lock behind on a pooled connection", async () => {
    await analysisOf(
      { sql: "SELECT pg_advisory_lock(id) FROM public.query_detail_probe" },
      [],
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

  it("gives a SELECT entry its actual execution stats when analyzed", async () => {
    const analysis = await analysisOf({
      sql: "SELECT count(*) FROM public.query_detail_probe",
    });

    const [plan] = JSON.parse(analysis.explain_plan);
    expect(plan["Execution Time"]).toEqual(expect.any(Number));
    expect(plan.Plan["Actual Rows"]).toBe(1);
  });

  it("lists a parameterized entry's parameters and analyzes it with the values given", async () => {
    const statement = {
      sql: "SELECT id FROM public.query_detail_probe WHERE id > $1",
      values: [0],
    };

    const detail = await detailOf(statement);
    expect(detail.explain_kind).toBe("generic");
    expect(detail.parameters).toEqual([
      { __typename: "QueryParameter", number: 1, type: "integer", list: false },
    ]);

    const analysis = await analysisOf(statement, [
      { number: 1, values: ["1"] },
    ]);
    const [plan] = JSON.parse(analysis.explain_plan);
    expect(plan["Execution Time"]).toEqual(expect.any(Number));
    expect(plan.Plan["Actual Rows"]).toBe(2);
  });

  it("runs a squashed IN list with every value given for it", async () => {
    const statement = {
      sql: "SELECT id FROM public.query_detail_probe WHERE id IN (1, 2, 3)",
      stored:
        "SELECT id FROM public.query_detail_probe WHERE id IN ($1 /*, ... */)",
    };

    const detail = await detailOf(statement);
    expect(detail.parameters).toEqual([
      { __typename: "QueryParameter", number: 1, type: "integer", list: true },
    ]);

    const analysis = await analysisOf(statement, [
      { number: 1, values: ["1", "3"] },
    ]);
    const [plan] = JSON.parse(analysis.explain_plan);
    expect(plan.Plan["Actual Rows"]).toBe(2);
  });

  it("lists and analyzes a constant that stood where nothing gives it a type", async () => {
    const statement = {
      sql: "SELECT json_build_object('id', id) FROM public.query_detail_probe WHERE id > $1",
      values: [0],
      stored:
        "SELECT json_build_object($2, id) FROM public.query_detail_probe WHERE id > $1",
    };

    const detail = await detailOf(statement);
    expect(detail.parameters).toEqual([
      { __typename: "QueryParameter", number: 1, type: "integer", list: false },
      { __typename: "QueryParameter", number: 2, type: "text", list: false },
    ]);

    const analysis = await analysisOf(statement, [
      { number: 1, values: ["1"] },
      { number: 2, values: ["id"] },
    ]);
    const [plan] = JSON.parse(analysis.explain_plan);
    expect(plan.Plan["Actual Rows"]).toBe(2);
  });

  it("runs a squashed IN list next to a constant that stood where nothing gives it a type", async () => {
    const analysis = await analysisOf(
      {
        sql: "SELECT json_build_object('id', id) FROM public.query_detail_probe WHERE id IN (1, 2, 3)",
        stored:
          "SELECT json_build_object($1, id) FROM public.query_detail_probe WHERE id IN ($2 /*, ... */)",
      },
      [
        { number: 1, values: ["id"] },
        { number: 2, values: ["1", "3"] },
      ],
    );

    const [plan] = JSON.parse(analysis.explain_plan);
    expect(plan.Plan["Actual Rows"]).toBe(2);
  });

  it("asks for the values of a parameterized entry analyzed without any", async () => {
    await expect(
      analysisOf({
        sql: "SELECT id FROM public.query_detail_probe WHERE id > $1",
        values: [0],
      }),
    ).rejects.toThrow("$1 needs a value");
  });

  it("treats a value as data, not SQL", async () => {
    const analysis = await analysisOf(
      {
        sql: "SELECT id FROM public.query_detail_probe WHERE $1::text = $2::text",
        values: ["x", "x"],
      },
      [
        { number: 1, values: ["x'; SELECT 1; --"] },
        { number: 2, values: ["x"] },
      ],
    );

    const [plan] = JSON.parse(analysis.explain_plan);
    expect(plan["Execution Time"]).toEqual(expect.any(Number));
  });

  it("refuses to analyze a parameterized entry with a value missing", async () => {
    await expect(
      analysisOf(
        {
          sql: "SELECT id FROM public.query_detail_probe WHERE id > $1 AND id < $2",
          values: [0, 9],
        },
        [{ number: 2, values: ["3"] }],
      ),
    ).rejects.toThrow("$1 needs a value");
  });
});
