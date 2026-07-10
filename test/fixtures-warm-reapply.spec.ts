import * as fs from "fs";
import * as path from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Production upgrades run setup() against a live database. Split out of
// fixtures.spec.ts so this heavy flow and the fresh-apply flow run on
// separate workers instead of back to back.
describe("dev fixtures warm re-apply (hasura/fixtures)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  const FIXTURES_DIR = path.resolve("./hasura/fixtures");

  const applyFile = (file: string) =>
    postgres.query(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8"));

  const count = async (sql: string) =>
    Number(
      (await postgres.query<Array<{ c: string }>>(`SELECT count(*) AS c FROM ${sql}`))[0].c,
    );

  beforeAll(async () => {
    db = await bootMigratedDb("FixturesWarmTest");
    postgres = db.postgres;
    await applyFile("cleanup.sql");
    await applyFile("fixtures.sql");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("setup() re-runs every SQL file over a data-full database", async () => {
    // Deleting the stored file digests forces every enum/function/view/trigger
    // file to re-apply (migrations stay applied via schema_migrations) —
    // catching files that only work on an empty schema, the regression class
    // the cold-start suite can't see.
    const before = await count("teams");
    expect(before).toBe(8);

    await postgres.query("DELETE FROM settings WHERE name LIKE 'hasura/%'");
    await db.hasura.setup();

    expect(await count("teams")).toBe(before);
    expect(await count("matches")).toBeGreaterThan(0);

    const disabled = await postgres.query<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE tgenabled = 'D'`,
    );
    expect(disabled).toEqual([]);
  }, 300_000);
});
