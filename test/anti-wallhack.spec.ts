import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Verifies the anti-wallhack migrations: match_options.anti_wallhack defaults
// to true (existing rows become protected) and match_maps.anti_wallhack_active
// is nullable (null = never reported by the game server plugin). Also covers
// clone_match_options propagating anti_wallhack onto cloned rows (tournament
// and best-of re-scheduling flows clone through this function) and the
// anti_wallhack_enabled kill switch being seeded on install.
describe("anti-wallhack columns (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("AntiWallhackTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27016);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("defaults match_options.anti_wallhack to true", async () => {
    const { poolId } = await fx.mapPool(1, { offset: 0 });
    const match = await fx.match({ mapPoolId: poolId });

    const rows = await postgres.query<Array<{ anti_wallhack: boolean }>>(
      "SELECT anti_wallhack FROM match_options WHERE id = $1",
      [match.options_id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].anti_wallhack).toBe(true);
  });

  it("declares match_maps.anti_wallhack_active as nullable boolean", async () => {
    const rows = await postgres.query<
      Array<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'match_maps'
          AND column_name = 'anti_wallhack_active'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("boolean");
    expect(rows[0].is_nullable).toBe("YES");
    expect(rows[0].column_default).toBeNull();
  });

  // Regression for clone_match_options omitting anti_wallhack from its column
  // lists: a cloned options row (tournament/league scheduling, best-of
  // re-cloning) would silently reset to the column default instead of
  // carrying the source row's value.
  it("clone_match_options carries anti_wallhack onto the cloned row", async () => {
    const optionsId = await fx.matchOptions();
    await postgres.query(
      "UPDATE match_options SET anti_wallhack = false WHERE id = $1",
      [optionsId],
    );

    const [{ cloned_id }] = await postgres.query<Array<{ cloned_id: string }>>(
      "SELECT clone_match_options($1) AS cloned_id",
      [optionsId],
    );

    const rows = await postgres.query<Array<{ anti_wallhack: boolean }>>(
      "SELECT anti_wallhack FROM match_options WHERE id = $1",
      [cloned_id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].anti_wallhack).toBe(false);
  });

  // hasura.service.ts's updateSettings() (run by bootMigratedDb via
  // HasuraService.setup()) seeds this row with `on conflict do nothing`, the
  // same way it seeds public.steam_presence_enabled, so a fresh install has
  // the kill switch on by default.
  it("seeds the anti_wallhack_enabled kill switch to true", async () => {
    const rows = await postgres.query<Array<{ value: string }>>(
      "SELECT value FROM settings WHERE name = 'anti_wallhack_enabled'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("true");
  });
});
