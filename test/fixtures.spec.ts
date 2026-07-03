import * as fs from "fs";
import * as path from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Guards the LOAD_FIXTURES=true dev seeding path (hasura/fixtures). The
// fixture scripts disable triggers and write straight to the tables, so
// nothing else catches them drifting from the live schema — this suite
// applies them against a freshly migrated database exactly the way
// HasuraService.setup() does (cleanup.sql first, then fixtures.sql).
describe("dev fixtures (hasura/fixtures)", () => {
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
    db = await bootMigratedDb("FixturesTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("applies cleanly on a fresh install and seeds the documented dataset", async () => {
    await applyFile("cleanup.sql");
    await applyFile("fixtures.sql");

    // The headline numbers from the fixture header: ~40 players, 8 teams,
    // ~143 matches, 4 tournaments.
    expect(await count("players")).toBeGreaterThanOrEqual(40);
    expect(await count("teams")).toBe(8);
    expect(await count("matches")).toBeGreaterThanOrEqual(100);
    expect(await count("tournaments")).toBe(4);
    expect(await count("match_map_rounds")).toBeGreaterThan(0);
    expect(await count("player_kills")).toBeGreaterThan(0);
    expect(await count("seasons")).toBeGreaterThan(0);

    const [flag] = await postgres.query<Array<{ value: string }>>(
      "SELECT value FROM settings WHERE name = 'dev.fixtures_loaded'",
    );
    expect(flag?.value).toBe("true");
  }, 180_000);

  it("leaves every disabled trigger re-enabled", async () => {
    // tgenabled 'D' would mean a fixture script disabled a trigger and never
    // restored it — silently turning off production behavior in dev.
    const disabled = await postgres.query<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE tgenabled = 'D'`,
    );
    expect(disabled).toEqual([]);
  });

  it("cleanup removes the fixture data and the loaded flag", async () => {
    await applyFile("cleanup.sql");

    expect(
      await count(
        "players WHERE steam_id BETWEEN 76561198000000001 AND 76561198000000040",
      ),
    ).toBe(0);
    expect(await count("teams")).toBe(0);
    expect(await count("tournaments")).toBe(0);
    expect(
      await count("settings WHERE name = 'dev.fixtures_loaded'"),
    ).toBe(0);
  }, 120_000);

  it("is idempotent: cleanup + fixtures re-applies without error", async () => {
    await applyFile("cleanup.sql");
    await applyFile("fixtures.sql");
    expect(await count("teams")).toBe(8);
  }, 180_000);
});
