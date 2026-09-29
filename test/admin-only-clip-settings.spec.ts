import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("admin-only clip settings", () => {
  let db: SqlTestDb;

  const migrations = join(__dirname, "../hasura/migrations/default");
  const sql = (migration: string, file: "up" | "down") =>
    readFileSync(join(migrations, migration, `${file}.sql`), "utf8");

  const publicUp = sql("1889000000300_public_clip_settings", "up");
  const up = sql("1889000000400_admin_only_clip_settings", "up");
  const down = sql("1889000000400_admin_only_clip_settings", "down");

  const NAMES = [
    "clip_fps",
    "clip_resolution",
    "public.clip_fps",
    "public.clip_resolution",
  ];

  const set = (name: string, value: string) =>
    db.postgres.query("INSERT INTO settings (name, value) VALUES ($1, $2)", [
      name,
      value,
    ]);

  const rows = async () =>
    Object.fromEntries(
      (
        await db.postgres.query<Array<{ name: string; value: string }>>(
          "SELECT name, value FROM settings WHERE name = any($1::text[]) ORDER BY name",
          [NAMES],
        )
      ).map(({ name, value }) => [name, value]),
    );

  beforeAll(async () => {
    db = await bootMigratedDb("AdminOnlyClipSettingsTest");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.postgres.query(
      "DELETE FROM settings WHERE name = any($1::text[])",
      [NAMES],
    );
  });

  it("moves the operator's values back to the admin-only names", async () => {
    await set("public.clip_fps", "30");
    await set("public.clip_resolution", "720p");

    await db.postgres.query(up);

    expect(await rows()).toEqual({
      clip_fps: "30",
      clip_resolution: "720p",
    });
  });

  it("keeps the value the admin page saved under the public name on a clash", async () => {
    await set("public.clip_fps", "30");
    await set("clip_fps", "60");

    await db.postgres.query(up);

    expect(await rows()).toEqual({ clip_fps: "30" });
  });

  it("changes nothing when run again", async () => {
    await set("public.clip_fps", "30");
    await set("public.clip_resolution", "720p");

    await db.postgres.query(up);
    await db.postgres.query(up);

    expect(await rows()).toEqual({
      clip_fps: "30",
      clip_resolution: "720p",
    });
  });

  it("keeps an install's value when it upgrades past both migrations at once", async () => {
    await set("clip_fps", "30");
    await set("clip_resolution", "720p");

    await db.postgres.query(publicUp);
    await db.postgres.query(up);

    expect(await rows()).toEqual({
      clip_fps: "30",
      clip_resolution: "720p",
    });
  });

  it("restores the public names on down", async () => {
    await set("clip_fps", "30");
    await set("clip_resolution", "720p");

    await db.postgres.query(down);

    expect(await rows()).toEqual({
      "public.clip_fps": "30",
      "public.clip_resolution": "720p",
    });
  });

  it("keeps the admin-only value on a clash when run down", async () => {
    await set("clip_fps", "30");
    await set("public.clip_fps", "60");

    await db.postgres.query(down);

    expect(await rows()).toEqual({ "public.clip_fps": "30" });
  });

  it("drops public rows an old web app writes after the rename", async () => {
    await set("clip_fps", "30");
    await set("public.clip_fps", "60");
    await set("public.clip_resolution", "1080p");

    await (
      db.hasura as unknown as { updateSettings(): Promise<void> }
    ).updateSettings();

    expect(await rows()).toEqual({ clip_fps: "30" });
  });
});
