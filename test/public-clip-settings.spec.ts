import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("public clip settings migration", () => {
  let db: SqlTestDb;

  const migration = join(
    __dirname,
    "../hasura/migrations/default/1889000000300_public_clip_settings",
  );
  const up = readFileSync(join(migration, "up.sql"), "utf8");
  const down = readFileSync(join(migration, "down.sql"), "utf8");

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
    db = await bootMigratedDb("PublicClipSettingsTest");
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

  it("moves the operator's values to the public names", async () => {
    await set("clip_fps", "30");
    await set("clip_resolution", "720p");

    await db.postgres.query(up);

    expect(await rows()).toEqual({
      "public.clip_fps": "30",
      "public.clip_resolution": "720p",
    });
  });

  it("keeps the operator's value over form defaults saved under the new name", async () => {
    await set("clip_fps", "30");
    await set("public.clip_fps", "60");

    await db.postgres.query(up);

    expect(await rows()).toEqual({ "public.clip_fps": "30" });
  });

  it("changes nothing when run again", async () => {
    await set("clip_fps", "30");
    await set("clip_resolution", "720p");

    await db.postgres.query(up);
    await db.postgres.query(up);

    expect(await rows()).toEqual({
      "public.clip_fps": "30",
      "public.clip_resolution": "720p",
    });
  });

  it("drops unprefixed rows an old web app writes after the rename", async () => {
    await set("public.clip_fps", "30");
    await set("clip_fps", "60");
    await set("clip_resolution", "1080p");

    await (
      db.hasura as unknown as { updateSettings(): Promise<void> }
    ).updateSettings();

    expect(await rows()).toEqual({ "public.clip_fps": "30" });
  });

  it("restores the old names on down", async () => {
    await set("public.clip_fps", "30");
    await set("public.clip_resolution", "720p");

    await db.postgres.query(down);

    expect(await rows()).toEqual({
      clip_fps: "30",
      clip_resolution: "720p",
    });
  });
});
