import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("veto scouting drops Rush", () => {
  let db: SqlTestDb;

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1890000000990_veto_scouting_no_rush/up.sql",
    ),
    "utf8",
  );

  beforeAll(async () => {
    db = await bootMigratedDb("VetoScoutingNoRushTest");

    for (const mode of ["competitive", "wingman", "duel", "rush"]) {
      await db.postgres.query(
        `INSERT INTO public.settings (name, value) VALUES ($1, 'false')
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
        [`public.veto_scouting_${mode}`],
      );
    }

    await db.postgres.query(up);
    await db.postgres.query(up);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("removes the Rush switch and keeps the others", async () => {
    const rows = await db.postgres.query<Array<{ name: string }>>(
      `SELECT name FROM public.settings
        WHERE name LIKE 'public.veto_scouting_%'
        ORDER BY name`,
    );
    expect(rows.map(({ name }) => name)).toEqual([
      "public.veto_scouting_competitive",
      "public.veto_scouting_duel",
      "public.veto_scouting_wingman",
    ]);
  });
});
