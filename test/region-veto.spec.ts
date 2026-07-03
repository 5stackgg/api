import { PostgresService } from "./../src/postgres/postgres.service";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the region veto SQL: turn order (get_region_veto_picking_lineup_id),
// verify_region_veto_pick enforcement (turn, LAN guard, last-region guard), and
// auto_select_region_veto (Decider insertion, region lock-in, going Live).
describe("region veto (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("RegionVetoTest");
    postgres = db.postgres;
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27016);
    await seedRegionWithServer(postgres, "TestC", 27017);
    // A LAN region exists but is never veto-able.
    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan) VALUES ('Lan', 'Lan', true)
       ON CONFLICT (value) DO NOTHING`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("UPDATE servers SET enabled = true");
  });

  // A match in Veto with only the region choice outstanding: the single-map
  // custom pool materializes maps at insert, so map veto is off the table.
  const createVetoMatch = async (
    regions: Array<string>,
    { mapVeto = false } = {},
  ) => {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    await postgres.query(
      `INSERT INTO _map_pool (map_pool_id, map_id)
       SELECT $1, id FROM maps WHERE type = 'Competitive' ORDER BY name LIMIT 1`,
      [pool.id],
    );
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       VALUES (12, 1, 'Competitive', $1, $2, true, $3) RETURNING id`,
      [pool.id, mapVeto, regions],
    );
    const [match] = await postgres.query<
      Array<{ id: string; lineup_1_id: string; lineup_2_id: string }>
    >(
      "INSERT INTO matches (match_options_id) VALUES ($1) RETURNING id, lineup_1_id, lineup_2_id",
      [options.id],
    );
    await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
      match.id,
    ]);
    return match;
  };

  const matchState = async (id: string) => {
    const [row] = await postgres.query<
      Array<{ status: string; region: string | null; picking: string | null }>
    >(
      `SELECT m.status, m.region, get_region_veto_picking_lineup_id(m) AS picking
       FROM matches m WHERE m.id = $1`,
      [id],
    );
    return row;
  };

  const ban = (matchId: string, lineupId: string, region: string) =>
    postgres.query(
      `INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region)
       VALUES ($1, 'Ban', $2, $3)`,
      [matchId, lineupId, region],
    );

  it("entering Veto clears the region while several are viable", async () => {
    const match = await createVetoMatch(["TestA", "TestB", "TestC"]);
    const state = await matchState(match.id);
    expect(state.status).toBe("Veto");
    expect(state.region).toBeNull();
    expect(state.picking).toBe(match.lineup_1_id);
  });

  it("rejects a ban out of turn", async () => {
    const match = await createVetoMatch(["TestA", "TestB", "TestC"]);
    await expect(ban(match.id, match.lineup_2_id, "TestA")).rejects.toThrow(
      /Expected other lineup/i,
    );
  });

  it("never allows banning the LAN region", async () => {
    const match = await createVetoMatch(["TestA", "TestB", "TestC"]);
    await expect(ban(match.id, match.lineup_1_id, "Lan")).rejects.toThrow(
      /Cannot ban LAN region/i,
    );
  });

  it("refuses to ban the last available region", async () => {
    const match = await createVetoMatch(["TestA", "TestB"]);
    // Knock region B's only server offline: A becomes the last viable region.
    await postgres.query(
      "UPDATE servers SET enabled = false WHERE region = 'TestB'",
    );

    await expect(ban(match.id, match.lineup_1_id, "TestA")).rejects.toThrow(
      /last available region/i,
    );
  });

  it("alternates turns and auto-decides the leftover region, going Live", async () => {
    const match = await createVetoMatch(["TestA", "TestB", "TestC"]);

    await ban(match.id, match.lineup_1_id, "TestA");
    expect((await matchState(match.id)).picking).toBe(match.lineup_2_id);

    await ban(match.id, match.lineup_2_id, "TestB");

    const picks = await postgres.query<Array<{ type: string; region: string }>>(
      "SELECT type, region FROM match_region_veto_picks WHERE match_id = $1 ORDER BY created_at",
      [match.id],
    );
    expect(picks.map((p) => [p.type, p.region])).toEqual([
      ["Ban", "TestA"],
      ["Ban", "TestB"],
      ["Decider", "TestC"],
    ]);

    const state = await matchState(match.id);
    expect(state.region).toBe("TestC");
    // Map veto disabled and maps already materialized: straight to Live.
    expect(state.status).toBe("Live");
    // Region locked in: nobody is prompted to pick again.
    expect(state.picking).toBeNull();
  });

  it("stays in Veto after the region decider when map veto is still pending", async () => {
    const match = await createVetoMatch(["TestA", "TestB"], { mapVeto: true });

    await ban(match.id, match.lineup_1_id, "TestA");

    const state = await matchState(match.id);
    expect(state.region).toBe("TestB");
    expect(state.status).toBe("Veto");
  });

  it("cancelling a match mid-veto wipes its region picks", async () => {
    const match = await createVetoMatch(["TestA", "TestB", "TestC"]);
    await ban(match.id, match.lineup_1_id, "TestA");

    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [match.id],
    );

    const picks = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_region_veto_picks WHERE match_id = $1",
      [match.id],
    );
    expect(picks.length).toBe(0);
  });
});
