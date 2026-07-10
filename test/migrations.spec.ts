import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Guards the cold-start migration -> enums -> functions -> views -> triggers
// pipeline: it is what regresses when an object's type changes underneath a
// file the auto-loader still re-applies (e.g. a view file left behind after
// the object became a table). Under jest-sql.config.js the pipeline runs for
// real in the global setup and this suite asserts against a clone of the
// result; standalone runs migrate from scratch per suite.
describe("hasura migrations (cold start)", () => {
  let db: SqlTestDb;

  beforeAll(async () => {
    db = await bootMigratedDb("MigrationTest");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const relkind = async (name: string) => {
    const rows = await db.postgres.query<Array<{ relkind: string }>>(
      "SELECT relkind FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace",
      [name],
    );
    return rows[0]?.relkind;
  };

  // The regression that motivated this test: v_team_stage_results became a
  // trigger-maintained cache table, but a stale CREATE OR REPLACE VIEW file was
  // re-applied over it on cold start and Postgres rejected it. 'r' = ordinary
  // table, 'v' = view.
  it("materializes v_team_stage_results as a table, not a view", async () => {
    expect(await relkind("v_team_stage_results")).toBe("r");
  });

  it("keeps the heavy standings logic as the compute view", async () => {
    expect(await relkind("v_team_stage_results_compute")).toBe("v");
    expect(await relkind("v_team_tournament_results")).toBe("v");
  });
});
