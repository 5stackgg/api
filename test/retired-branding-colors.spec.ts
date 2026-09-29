import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("retired light-mode branding colours", () => {
  let db: SqlTestDb;

  const NAMES = [
    "public.color_primary",
    "public.color_sidebar_background",
    "public.color_dark_primary",
    "public.color_dark_sidebar_background",
  ];

  const names = async () =>
    (
      await db.postgres.query<Array<{ name: string }>>(
        "SELECT name FROM settings WHERE name = any($1::text[]) ORDER BY name",
        [NAMES],
      )
    ).map(({ name }) => name);

  beforeAll(async () => {
    db = await bootMigratedDb("RetiredBrandingColorsTest");

    for (const name of NAMES) {
      await db.postgres.query(
        "INSERT INTO settings (name, value) VALUES ($1, '210 40% 50%')",
        [name],
      );
    }

    await (
      db.hasura as unknown as { updateSettings(): Promise<void> }
    ).updateSettings();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("drops the light-mode rows and keeps the dark palette", async () => {
    expect(await names()).toEqual([
      "public.color_dark_primary",
      "public.color_dark_sidebar_background",
    ]);
  });
});
