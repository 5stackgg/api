import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Maps are soft deleted (maps.deleted_at) so the rows that finished matches
// point at survive. Covers what the DB layer guarantees around that flag:
// a deleted map leaves every pool, the seed-pool sync ignores it, pools
// refuse it, and restoring puts an active-duty map back where it was.
describe("maps soft delete (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  const MAP = "de_softdelete_test";

  beforeAll(async () => {
    db = await bootMigratedDb("MapsSoftDeleteTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM maps WHERE name = $1", [MAP]);
    await postgres.query(
      "DELETE FROM map_pools WHERE type = 'Custom' AND NOT EXISTS (SELECT 1 FROM _map_pool WHERE map_pool_id = map_pools.id)",
    );
    await postgres.query(
      "INSERT INTO settings (name, value) VALUES ('update_map_pools', 'true') ON CONFLICT (name) DO UPDATE SET value = 'true'",
    );
  });

  const createMap = async (activePool = false) => {
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO maps (name, type, active_pool, enabled)
       VALUES ($1, 'Competitive', $2, true) RETURNING id`,
      [MAP, activePool],
    );
    return map.id;
  };

  const poolIdsOf = async (mapId: string) => {
    const rows = await postgres.query<Array<{ map_pool_id: string }>>(
      "SELECT map_pool_id FROM _map_pool WHERE map_id = $1",
      [mapId],
    );
    return rows.map((row) => row.map_pool_id);
  };

  const seedPoolId = async () => {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE type = 'Competitive' AND seed = true AND enabled = true LIMIT 1",
    );
    return pool.id;
  };

  const softDelete = (mapId: string) =>
    postgres.query("UPDATE maps SET deleted_at = now() WHERE id = $1", [mapId]);

  const restore = (mapId: string) =>
    postgres.query("UPDATE maps SET deleted_at = NULL WHERE id = $1", [mapId]);

  it("drops a soft-deleted map out of every pool it was in", async () => {
    const mapId = await createMap();
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    await postgres.query(
      "INSERT INTO _map_pool (map_pool_id, map_id) VALUES ($1, $2)",
      [pool.id, mapId],
    );
    expect(await poolIdsOf(mapId)).toEqual([pool.id]);

    await softDelete(mapId);

    expect(await poolIdsOf(mapId)).toEqual([]);
    const [row] = await postgres.query<Array<{ deleted_at: Date | null }>>(
      "SELECT deleted_at FROM maps WHERE id = $1",
      [mapId],
    );
    expect(row.deleted_at).not.toBeNull();
  });

  it("keeps a soft-deleted active-duty map out of the seed pool sync", async () => {
    const mapId = await createMap(true);
    await postgres.query("SELECT update_map_pools()");
    expect(await poolIdsOf(mapId)).toContain(await seedPoolId());

    await softDelete(mapId);
    expect(await poolIdsOf(mapId)).toEqual([]);

    await postgres.query("SELECT update_map_pools()");
    expect(await poolIdsOf(mapId)).toEqual([]);
  });

  it("refuses to add a soft-deleted map to a pool", async () => {
    const mapId = await createMap();
    await softDelete(mapId);
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );

    await expect(
      postgres.query(
        "INSERT INTO v_pool_maps (map_pool_id, id) VALUES ($1, $2)",
        [pool.id, mapId],
      ),
    ).rejects.toThrow(/has been deleted/);
  });

  it("restoring an active-duty map puts it back in the seed pool", async () => {
    const mapId = await createMap(true);
    await postgres.query("SELECT update_map_pools()");
    const seed = await seedPoolId();
    expect(await poolIdsOf(mapId)).toContain(seed);

    await softDelete(mapId);
    expect(await poolIdsOf(mapId)).toEqual([]);

    await restore(mapId);
    expect(await poolIdsOf(mapId)).toContain(seed);
  });

  it("restoring keeps the same row so match history still resolves", async () => {
    const mapId = await createMap();
    await softDelete(mapId);
    await restore(mapId);

    const rows = await postgres.query<
      Array<{ id: string; deleted_at: Date | null }>
    >("SELECT id, deleted_at FROM maps WHERE name = $1", [MAP]);
    expect(rows).toEqual([{ id: mapId, deleted_at: null }]);
  });

  it("the map seed upsert leaves an admin's deletion alone", async () => {
    const mapId = await createMap();
    await softDelete(mapId);

    await postgres.query(
      `INSERT INTO maps (name, type, active_pool, workshop_map_id, poster, patch, label)
       VALUES ($1, 'Competitive', true, NULL, '/poster.webp', NULL, NULL)
       ON CONFLICT (name, type) DO UPDATE SET
         active_pool = EXCLUDED.active_pool,
         poster = EXCLUDED.poster`,
      [MAP],
    );

    const [row] = await postgres.query<
      Array<{ id: string; deleted_at: Date | null; poster: string }>
    >("SELECT id, deleted_at, poster FROM maps WHERE name = $1", [MAP]);
    expect(row.id).toBe(mapId);
    expect(row.deleted_at).not.toBeNull();
    expect(row.poster).toBe("/poster.webp");
    expect(await poolIdsOf(mapId)).toEqual([]);
  });
});
