import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";

describe("seed map pools on boot (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const seedSql = readFileSync(
    join(__dirname, "../hasura/enums/maps.sql"),
    "utf8",
  );

  beforeAll(async () => {
    db = await bootMigratedDb("MapPoolSeedTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199800000000n);
    await seedRegionWithServer(postgres, "TestA");
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

  afterEach(async () => {
    await postgres.query("DELETE FROM maps WHERE name = 'de_sync_probe'");
    await postgres.query(
      "UPDATE maps SET enabled = true WHERE enabled = false",
    );
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
        WHERE type = 'Competitive' AND active_pool AND enabled AND deleted_at IS NULL
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

  const livePool = async () => {
    const pools = await enabledSeedPoolIds();
    expect(pools).toHaveLength(1);
    return pools[0];
  };

  it("puts missing active-duty maps back when update_map_pools is turned on", async () => {
    await setUpdateMapPools("false");
    await customiseLivePool();

    await setUpdateMapPools("true");

    expect(await mapNamesIn(await livePool())).toEqual(await activeDuty());
  });

  it("drops maps that left active duty when update_map_pools is turned on", async () => {
    await setUpdateMapPools("false");
    await postgres.query(
      `INSERT INTO _map_pool (map_pool_id, map_id)
       SELECT $1, id FROM maps WHERE name = 'de_train' AND type = 'Competitive'`,
      [await livePool()],
    );

    await setUpdateMapPools("true");

    expect(await mapNamesIn(await livePool())).toEqual(await activeDuty());
    expect(await mapNamesIn(await livePool())).not.toContain("de_train");
  });

  const poolExists = async (poolId: string) => {
    const rows = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE id = $1",
      [poolId],
    );
    return rows.length === 1;
  };

  it("follows Active Duty flipped in the panel, leaving the old pool to the matches already on it", async () => {
    const poolId = await livePool();
    const before = await mapNamesIn(poolId);
    await fx.matchOptions({ mapPoolId: poolId });

    await postgres.query(
      "UPDATE maps SET active_pool = true WHERE name = 'de_overpass'",
    );
    await postgres.query(
      "UPDATE maps SET active_pool = false WHERE name = 'de_cache'",
    );

    const live = await livePool();
    expect(live).not.toBe(poolId);
    expect(await mapNamesIn(live)).toEqual(await activeDuty());
    expect(await mapNamesIn(live)).toContain("de_overpass");
    expect(await mapNamesIn(live)).not.toContain("de_cache");
    expect(await mapNamesIn(poolId)).toEqual(before);
  });

  it("drops a replaced pool nothing plays from on the next sync, not the one that replaced it", async () => {
    const poolId = await livePool();

    await postgres.query(
      "UPDATE maps SET active_pool = true WHERE name = 'de_overpass'",
    );
    const replacement = await livePool();
    expect(replacement).not.toBe(poolId);
    expect(await poolExists(poolId)).toBe(true);

    await postgres.query(
      "UPDATE maps SET active_pool = false WHERE name = 'de_cache'",
    );

    expect(await poolExists(poolId)).toBe(false);
    expect(await poolExists(replacement)).toBe(true);
  });

  it("keeps a replaced pool a draft game is set to play from", async () => {
    const poolId = await livePool();
    const [draft] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO draft_games (host_steam_id, type, map_pool_id)
       VALUES ($1, 'Competitive', $2) RETURNING id`,
      [await fx.player(), poolId],
    );

    try {
      await postgres.query(
        "UPDATE maps SET active_pool = true WHERE name = 'de_overpass'",
      );
      await postgres.query(
        "UPDATE maps SET active_pool = false WHERE name = 'de_cache'",
      );

      expect(await livePool()).not.toBe(poolId);
      expect(await poolExists(poolId)).toBe(true);
    } finally {
      await postgres.query("DELETE FROM draft_games WHERE id = $1", [draft.id]);
    }
  });

  it("serialises concurrent Active Duty changes so the live pool ends up with both", async () => {
    type Client = {
      query(
        sql: string,
        params?: Array<unknown>,
      ): Promise<{ rows: Array<Record<string, unknown>> }>;
      release(): void;
    };
    const pool = (
      postgres as unknown as { pool: { connect(): Promise<Client> } }
    ).pool;
    const first = await pool.connect();
    const second = await pool.connect();
    const {
      rows: [{ pid: secondPid }],
    } = await second.query("SELECT pg_backend_pid() AS pid");
    let flipped: Promise<unknown> | undefined;
    let firstOpen = false;
    let secondOpen = false;

    try {
      await first.query("BEGIN");
      firstOpen = true;
      await first.query(
        "UPDATE maps SET active_pool = true WHERE name = 'de_overpass'",
      );

      await second.query("BEGIN");
      secondOpen = true;
      flipped = second.query(
        "UPDATE maps SET active_pool = false WHERE name = 'de_cache'",
      );

      for (let attempt = 0; ; attempt++) {
        const [row] = await postgres.query<Array<{ waiting: number }>>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE pid = $1 AND wait_event_type = 'Lock'`,
          [Number(secondPid)],
        );
        if (row.waiting > 0) {
          break;
        }
        if (attempt > 400) {
          throw new Error("the second change never waited on the first");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await first.query("COMMIT");
      firstOpen = false;
      await flipped;
      await second.query("COMMIT");
      secondOpen = false;
    } finally {
      if (firstOpen) {
        await first.query("ROLLBACK");
      }
      await flipped?.catch((): void => undefined);
      if (secondOpen) {
        await second.query("ROLLBACK");
      }
      first.release();
      second.release();
    }

    const live = await livePool();
    expect(await mapNamesIn(live)).toEqual(await activeDuty());
    expect(await mapNamesIn(live)).toContain("de_overpass");
    expect(await mapNamesIn(live)).not.toContain("de_cache");
  });

  it("adds a map created with Active Duty on", async () => {
    await postgres.query(
      `INSERT INTO maps (name, type, active_pool, enabled)
       VALUES ('de_sync_probe', 'Competitive', true, true)`,
    );

    expect(await mapNamesIn(await livePool())).toContain("de_sync_probe");
    expect(await mapNamesIn(await livePool())).toEqual(await activeDuty());
  });

  it("drops an active-duty map whose mode is turned off", async () => {
    await postgres.query(
      "UPDATE maps SET enabled = false WHERE name = 'de_nuke' AND type = 'Competitive'",
    );

    expect(await mapNamesIn(await livePool())).not.toContain("de_nuke");
    expect(await mapNamesIn(await livePool())).toEqual(await activeDuty());
  });

  it("leaves the pool alone when Active Duty is flipped with update_map_pools off", async () => {
    await setUpdateMapPools("false");
    const poolId = await livePool();
    const before = await mapNamesIn(poolId);

    await postgres.query(
      "UPDATE maps SET active_pool = true WHERE name = 'de_overpass'",
    );

    expect(await livePool()).toBe(poolId);
    expect(await mapNamesIn(poolId)).toEqual(before);
  });

  it("keeps a mode's pool when none of its maps are active duty", async () => {
    const [rushPool] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE type = 'Rush' AND seed AND enabled",
    );

    await postgres.query(
      "UPDATE maps SET active_pool = false WHERE type = 'Rush'",
    );

    const rushPools = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE type = 'Rush' AND seed AND enabled",
    );
    expect(rushPools.map((row) => row.id)).toEqual([rushPool.id]);
    expect(await mapNamesIn(rushPool.id)).toEqual(["rush_001"]);
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

  const activeIn = async (type: string) => {
    const rows = await postgres.query<Array<{ name: string }>>(
      `SELECT name FROM maps
        WHERE type = $1 AND active_pool AND deleted_at IS NULL
        ORDER BY name`,
      [type],
    );
    return rows.map((row) => row.name);
  };

  // Valve's pools as of the July 8, 2026 update; change these with the next rotation.
  it("seeds Valve's current Active Duty and Wingman pools", async () => {
    const wingman = [
      "de_debris",
      "de_eldorado",
      "de_inferno",
      "de_nuke",
      "de_overpass",
      "de_poseidon",
      "de_vertigo",
    ];

    expect(await activeIn("Competitive")).toEqual([
      "de_ancient",
      "de_anubis",
      "de_cache",
      "de_dust2",
      "de_inferno",
      "de_mirage",
      "de_nuke",
    ]);
    expect(await activeIn("Wingman")).toEqual(wingman);
    expect(await activeIn("Duel")).toEqual(wingman);
    expect(await activeIn("Rush")).toEqual(["rush_001"]);
  });

  // A community map can leave the client, so it keeps the id to load from the
  // Workshop; the game server still plays the client's copy while it ships.
  it("gives community maps their workshop ids", async () => {
    const community = await postgres.query<
      Array<{ name: string; workshop_map_id: string | null }>
    >(
      `SELECT DISTINCT name, workshop_map_id FROM maps
        WHERE name IN ('cs_shelter', 'de_boulder', 'de_debris', 'de_eldorado', 'de_fachwerk', 'de_poseidon')
        ORDER BY name`,
    );
    expect(community).toEqual([
      { name: "cs_shelter", workshop_map_id: "3737179295" },
      { name: "de_boulder", workshop_map_id: "3663186989" },
      { name: "de_debris", workshop_map_id: "3539217452" },
      { name: "de_eldorado", workshop_map_id: "3408790618" },
      { name: "de_fachwerk", workshop_map_id: "3442040035" },
      { name: "de_poseidon", workshop_map_id: "3522144043" },
    ]);
  });

  // The map pickers file every map without a workshop id under Valve's own.
  it("leaves only Valve's maps without a workshop id", async () => {
    const rows = await postgres.query<Array<{ name: string }>>(
      `SELECT DISTINCT name FROM maps
        WHERE workshop_map_id IS NULL AND deleted_at IS NULL
        ORDER BY name`,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "cs_italy",
      "cs_office",
      "de_ancient",
      "de_ancient_night",
      "de_anubis",
      "de_cache",
      "de_dust2",
      "de_inferno",
      "de_mirage",
      "de_nuke",
      "de_overpass",
      "de_train",
      "de_vertigo",
      "rush_001",
    ]);
  });

  it("switches off a retired mode and gives every mode row its map's details", async () => {
    await postgres.query(
      `INSERT INTO maps (name, type, active_pool, enabled)
       VALUES ('de_debris', 'Competitive', false, true),
              ('de_eldorado', 'Competitive', true, true),
              ('de_brewery', 'Competitive', false, true),
              ('de_sync_probe', 'Competitive', false, true)`,
    );

    try {
      await reseed();

      const rows = await postgres.query<
        Array<{
          name: string;
          enabled: boolean;
          workshop_map_id: string | null;
        }>
      >(
        `SELECT name, enabled, workshop_map_id FROM maps
          WHERE type = 'Competitive'
            AND name IN ('de_brewery', 'de_debris', 'de_eldorado', 'de_sync_probe')
          ORDER BY name`,
      );
      expect(rows).toEqual([
        { name: "de_brewery", enabled: true, workshop_map_id: "3070290240" },
        { name: "de_debris", enabled: false, workshop_map_id: "3539217452" },
        { name: "de_eldorado", enabled: false, workshop_map_id: "3408790618" },
        { name: "de_sync_probe", enabled: true, workshop_map_id: null },
      ]);
    } finally {
      await postgres.query(
        "DELETE FROM maps WHERE type = 'Competitive' AND name IN ('de_brewery', 'de_debris', 'de_eldorado')",
      );
    }
  });

  it("offers Italy and Shelter as Competitive maps outside Active Duty", async () => {
    const maps = await postgres.query<
      Array<{ name: string; active_pool: boolean }>
    >(
      `SELECT name, active_pool FROM maps
        WHERE name IN ('cs_italy', 'cs_shelter') AND type = 'Competitive'
        ORDER BY name`,
    );
    expect(maps).toEqual([
      { name: "cs_italy", active_pool: false },
      { name: "cs_shelter", active_pool: false },
    ]);
  });
});
