import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// setup() skips a boot-phase file whose digest is unchanged. Recreating a view
// drops the triggers on it and, with CASCADE, the views built on it, while the
// files that define those still match their digests.
describe("re-applying a view at boot (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("ViewReapplyTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const changeView = async (file: string) => {
    const [row] = await postgres.query<Array<{ name: string }>>(
      `UPDATE migration_hashes.hashes SET hash = 'changed'
        WHERE name = $1 RETURNING name`,
      [`hasura/views/${file}`],
    );
    expect(row?.name).toBe(`hasura/views/${file}`);
  };

  const triggersOn = async (relation: string) =>
    (
      await postgres.query<Array<{ tgname: string }>>(
        `SELECT t.tgname FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = $1 AND NOT t.tgisinternal
          ORDER BY t.tgname`,
        [relation],
      )
    ).map(({ tgname }) => tgname);

  const viewExists = async (name: string) => {
    const [{ exists }] = await postgres.query<Array<{ exists: boolean }>>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${name}`],
    );
    return exists;
  };

  it("puts back the INSTEAD OF triggers on v_pool_maps, so a pool insert still works", async () => {
    const triggers = ["td_v_pool_maps", "ti_v_pool_maps", "tu_v_pool_maps"];
    expect(await triggersOn("v_pool_maps")).toEqual(triggers);

    await changeView("v_pool_maps");
    await db.hasura.setup();

    expect(await triggersOn("v_pool_maps")).toEqual(triggers);

    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    const [map] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM maps WHERE deleted_at IS NULL ORDER BY name LIMIT 1",
    );
    await postgres.query(
      "INSERT INTO v_pool_maps (map_pool_id, id) VALUES ($1, $2)",
      [pool.id, map.id],
    );

    const [{ count }] = await postgres.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM _map_pool WHERE map_pool_id = $1",
      [pool.id],
    );
    expect(count).toBe(1);
  });

  it("puts back the views a DROP VIEW ... CASCADE took with it", async () => {
    expect(await viewExists("player_performance_v")).toBe(true);

    await changeView("v_player_perf_career");
    await db.hasura.setup();

    expect(await viewExists("player_career_stats_v")).toBe(true);
    expect(await viewExists("player_performance_v")).toBe(true);
  });

  it("re-applies nothing when no file changed", async () => {
    const setSetting = jest.spyOn(db.hasura, "setSetting");

    await db.hasura.setup();

    expect(setSetting).not.toHaveBeenCalled();
    setSetting.mockRestore();
  });
});
