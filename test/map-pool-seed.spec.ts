import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("seed map pools on boot (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  const seedSql = readFileSync(
    join(__dirname, "../hasura/enums/maps.sql"),
    "utf8",
  );

  beforeAll(async () => {
    db = await bootMigratedDb("MapPoolSeedTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const setUpdateMapPools = (value: string) =>
    postgres.query(
      "INSERT INTO settings (name, value) VALUES ('update_map_pools', $1) ON CONFLICT (name) DO UPDATE SET value = $1",
      [value],
    );

  const reseed = () => postgres.query(seedSql);

  const enabledSeedPoolIds = async () => {
    const rows = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE type = 'Competitive' AND seed = true AND enabled = true",
    );
    return rows.map((row) => row.id);
  };

  const mapNamesIn = async (poolId: string) => {
    const rows = await postgres.query<Array<{ name: string }>>(
      `SELECT m.name FROM _map_pool mp
         JOIN maps m ON m.id = mp.map_id
        WHERE mp.map_pool_id = $1
        ORDER BY m.name`,
      [poolId],
    );
    return rows.map((row) => row.name);
  };

  const customiseLivePool = async () => {
    const [poolId] = await enabledSeedPoolIds();
    await postgres.query(
      `DELETE FROM _map_pool
        WHERE map_pool_id = $1
          AND map_id = (SELECT id FROM maps WHERE name = 'de_dust2' AND type = 'Competitive')`,
      [poolId],
    );
    return poolId;
  };

  beforeEach(async () => {
    await setUpdateMapPools("true");
    await reseed();
  });

  it("leaves an operator's pool alone when update_map_pools is off", async () => {
    await setUpdateMapPools("false");
    const poolId = await customiseLivePool();
    const customised = await mapNamesIn(poolId);

    await reseed();

    expect(await enabledSeedPoolIds()).toEqual([poolId]);
    expect(await mapNamesIn(poolId)).toEqual(customised);
    expect(customised).not.toContain("de_dust2");
  });

  it("still swaps a mismatched pool for the active-duty set when update_map_pools is on", async () => {
    const poolId = await customiseLivePool();

    await reseed();

    const [replacement] = await enabledSeedPoolIds();
    expect(replacement).not.toBe(poolId);
    expect(await mapNamesIn(replacement)).toContain("de_dust2");
  });

  const valveRotation = () => {
    const rotated = seedSql
      .replace(
        "('de_cache', 'Competitive', true)",
        "('de_cache', 'Competitive', false)",
      )
      .replace(
        "('de_overpass', 'Competitive', false)",
        "('de_overpass', 'Competitive', true)",
      );
    expect(rotated).toContain("('de_cache', 'Competitive', false)");
    expect(rotated).toContain("('de_overpass', 'Competitive', true)");
    return rotated;
  };

  const activeDuty = async () => {
    const rows = await postgres.query<Array<{ name: string }>>(
      `SELECT name FROM maps
        WHERE type = 'Competitive' AND active_pool = true AND deleted_at IS NULL
        ORDER BY name`,
    );
    return rows.map((row) => row.name);
  };

  it("moves the live pool to a new active-duty list when update_map_pools is on", async () => {
    const [poolId] = await enabledSeedPoolIds();

    await postgres.query(valveRotation());

    const pools = await enabledSeedPoolIds();
    expect(pools).toHaveLength(1);
    expect(pools[0]).not.toBe(poolId);
    expect(await mapNamesIn(pools[0])).toEqual(await activeDuty());
    expect(await mapNamesIn(pools[0])).toContain("de_overpass");
    expect(await mapNamesIn(pools[0])).not.toContain("de_cache");
  });

  it("keeps the operator's pool through a new active-duty list when update_map_pools is off", async () => {
    await setUpdateMapPools("false");
    const [poolId] = await enabledSeedPoolIds();
    const before = await mapNamesIn(poolId);

    await postgres.query(valveRotation());

    expect(await enabledSeedPoolIds()).toEqual([poolId]);
    expect(await mapNamesIn(poolId)).toEqual(before);
  });

  it("puts missing active-duty maps back when update_map_pools is turned on", async () => {
    await setUpdateMapPools("false");
    const poolId = await customiseLivePool();

    await setUpdateMapPools("true");

    expect(await mapNamesIn(poolId)).toEqual(await activeDuty());
  });

  it("treats a missing update_map_pools setting as on", async () => {
    await postgres.query(
      "DELETE FROM settings WHERE name = 'update_map_pools'",
    );
    const poolId = await customiseLivePool();

    await reseed();

    const [replacement] = await enabledSeedPoolIds();
    expect(replacement).not.toBe(poolId);
  });
});
