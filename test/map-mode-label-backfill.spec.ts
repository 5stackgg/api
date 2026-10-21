import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("map mode label backfill", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1890000001150_map_mode_labels/up.sql",
    ),
    "utf8",
  );

  const MAP = "de_label_backfill_test";

  beforeAll(async () => {
    db = await bootMigratedDb("MapModeLabelBackfillTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM maps WHERE name LIKE $1", [`${MAP}%`]);
  });

  const copy = (
    type: string,
    label: string | null,
    { name = MAP, deleted = false } = {},
  ) =>
    postgres.query(
      `INSERT INTO maps (name, type, label, workshop_map_id, active_pool, enabled, deleted_at)
       VALUES ($1, $2, $3, '3999999999', false, true, CASE WHEN $4 THEN now() END)`,
      [name, type, label, deleted],
    );

  const labels = async (name = MAP) =>
    Object.fromEntries(
      (
        await postgres.query<Array<{ type: string; label: string | null }>>(
          "SELECT type, label FROM maps WHERE name = $1 ORDER BY type",
          [name],
        )
      ).map(({ type, label }) => [type, label]),
    );

  it("gives an unlabelled mode copy the label the map already has", async () => {
    await copy("Wingman", "Mills (night)");
    await copy("Duel", null);

    await postgres.query(up);

    expect(await labels()).toEqual({
      Duel: "Mills (night)",
      Wingman: "Mills (night)",
    });
  });

  it("takes the Competitive copy's label when the copies disagree", async () => {
    await copy("Competitive", "Mills");
    await copy("Wingman", "Mills 2v2");
    await copy("Duel", null);

    await postgres.query(up);

    expect(await labels()).toEqual({
      Competitive: "Mills",
      Duel: "Mills",
      Wingman: "Mills 2v2",
    });
  });

  it("leaves a map with no label anywhere unlabelled", async () => {
    await copy("Wingman", null);
    await copy("Duel", null);

    await postgres.query(up);

    expect(await labels()).toEqual({ Duel: null, Wingman: null });
  });

  it("never copies a blank label or one from a deleted copy", async () => {
    await copy("Competitive", "Retired", { deleted: true });
    await copy("Wingman", "");
    await copy("Duel", null);

    await postgres.query(up);

    expect(await labels()).toEqual({
      Competitive: "Retired",
      Duel: null,
      Wingman: "",
    });
  });

  it("only copies within the same map", async () => {
    await copy("Wingman", "Other map", { name: `${MAP}_other` });
    await copy("Duel", null);

    await postgres.query(up);

    expect(await labels()).toEqual({ Duel: null });
  });

  it("changes nothing when run again", async () => {
    await copy("Competitive", "Mills");
    await copy("Duel", null);

    await postgres.query(up);
    await postgres.query(up);

    expect(await labels()).toEqual({ Competitive: "Mills", Duel: "Mills" });
  });
});
