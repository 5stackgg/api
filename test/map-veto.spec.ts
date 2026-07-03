import { PostgresService } from "./../src/postgres/postgres.service";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the map veto SQL: get_map_veto_pattern / get_map_veto_type /
// get_map_veto_picking_lineup_id, verify_map_veto_pick enforcement, and
// create_match_map_from_veto (map materialization, side assignment, the
// auto-inserted Decider, and going Live when the veto completes).
describe("map veto (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("MapVetoTest");
    postgres = db.postgres;
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
  });

  const createPool = async (size: number) => {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    const maps = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO _map_pool (map_pool_id, map_id)
       SELECT $1, id FROM maps WHERE type = 'Competitive' ORDER BY name LIMIT $2
       RETURNING map_id AS id`,
      [pool.id, size],
    );
    return { poolId: pool.id, mapIds: maps.map((m) => m.id) };
  };

  // A match sitting in Veto: single viable region (pre-selected on insert) so
  // only the map veto is outstanding when we push it towards Live.
  const createVetoMatch = async (bestOf: number, poolSize: number) => {
    const { poolId, mapIds } = await createPool(poolSize);
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       VALUES (12, $1, 'Competitive', $2, true, true, '{TestA}') RETURNING id`,
      [bestOf, poolId],
    );
    const [match] = await postgres.query<
      Array<{ id: string; lineup_1_id: string; lineup_2_id: string }>
    >(
      "INSERT INTO matches (match_options_id) VALUES ($1) RETURNING id, lineup_1_id, lineup_2_id",
      [options.id],
    );
    // tbu_matches redirects Live to Veto while maps are missing.
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    return { ...match, mapIds };
  };

  const vetoState = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{ status: string; veto_type: string | null; picking: string | null }>
    >(
      `SELECT m.status, get_map_veto_type(m) AS veto_type,
              get_map_veto_picking_lineup_id(m) AS picking
       FROM matches m WHERE m.id = $1`,
      [matchId],
    );
    return row;
  };

  const insertPick = (
    matchId: string,
    type: string,
    lineupId: string,
    mapId: string,
    side: string | null = null,
  ) =>
    postgres.query(
      `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, side)
       VALUES ($1, $2, $3, $4, $5)`,
      [matchId, type, lineupId, mapId, side as never],
    );

  it("computes the CS rulebook patterns", async () => {
    const bo1 = await createVetoMatch(1, 3);
    const [{ pattern: p1 }] = await postgres.query<
      Array<{ pattern: string[] }>
    >("SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1", [
      bo1.id,
    ]);
    expect(p1).toEqual(["Ban", "Ban", "Decider"]);

    const bo3 = await createVetoMatch(3, 4);
    const [{ pattern: p3 }] = await postgres.query<
      Array<{ pattern: string[] }>
    >("SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1", [
      bo3.id,
    ]);
    expect(p3).toEqual(["Ban", "Pick", "Side", "Pick", "Side", "Decider"]);
  });

  it("enforces type, turn, side, and pool membership", async () => {
    const match = await createVetoMatch(1, 3);

    const state = await vetoState(match.id);
    expect(state.status).toBe("Veto");
    expect(state.veto_type).toBe("Ban");
    expect(state.picking).toBe(match.lineup_1_id);

    // Wrong type for the current step.
    await expect(
      insertPick(match.id, "Pick", match.lineup_1_id, match.mapIds[0]),
    ).rejects.toThrow(/Expected pick type of Ban/i);

    // Wrong lineup for the current turn.
    await expect(
      insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[0]),
    ).rejects.toThrow(/Expected other lineup/i);

    // A Ban must not carry a side.
    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0], "CT"),
    ).rejects.toThrow(/Cannot Ban and choose side/i);

    // Maps outside the match's pool are not pickable.
    const [foreignMap] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM maps WHERE type = 'Wingman' LIMIT 1",
    );
    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, foreignMap.id),
    ).rejects.toThrow(/Map not available/i);
  });

  it("reports no active veto step outside the Veto status", async () => {
    const { poolId } = await createPool(3);
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       VALUES (12, 1, 'Competitive', $1, true, true, '{TestA}') RETURNING id`,
      [poolId],
    );
    const [match] = await postgres.query<
      Array<{ id: string; lineup_1_id: string }>
    >(
      "INSERT INTO matches (match_options_id) VALUES ($1) RETURNING id, lineup_1_id",
      [options.id],
    );

    // Still PickingPlayers: no veto type, no picking lineup, and the Hasura
    // permission function (the actual gate for inserts) denies the pick.
    // Note verify_map_veto_pick itself does NOT raise here — its comparisons
    // against a NULL step are silently true — so the permission layer is the
    // only thing standing between a client and an out-of-phase pick.
    const state = await vetoState(match.id);
    expect(state.veto_type).toBeNull();
    expect(state.picking).toBeNull();

    const [{ allowed }] = await postgres.query<
      Array<{ allowed: boolean | null }>
    >(
      `SELECT lineup_is_picking_map_veto(ml) AS allowed
       FROM match_lineups ml WHERE ml.id = $1`,
      [match.lineup_1_id],
    );
    // NULL (no active step) — Hasura treats anything but true as denied.
    expect(allowed).toBeFalsy();
  });

  it("runs a BO1 veto: alternating bans, auto-Decider, map materialized, match Live", async () => {
    const match = await createVetoMatch(1, 3);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    expect((await vetoState(match.id)).picking).toBe(match.lineup_2_id);

    await insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[1]);

    const picks = await postgres.query<Array<{ type: string; map_id: string }>>(
      "SELECT type, map_id FROM match_map_veto_picks WHERE match_id = $1 ORDER BY created_at",
      [match.id],
    );
    expect(picks.map((p) => p.type)).toEqual(["Ban", "Ban", "Decider"]);
    expect(picks[2].map_id).toBe(match.mapIds[2]);

    const maps = await postgres.query<
      Array<{ map_id: string; order: number }>
    >('SELECT map_id, "order" FROM match_maps WHERE match_id = $1', [match.id]);
    expect(maps.length).toBe(1);
    expect(maps[0].map_id).toBe(match.mapIds[2]);

    expect((await vetoState(match.id)).status).toBe("Live");
  });

  it("runs the BO3 Pick/Side steps and assigns the chosen side to the picking lineup", async () => {
    const match = await createVetoMatch(3, 4);

    // Step 1: Ban (lineup 1 opens).
    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);

    // Step 2: Pick — follow whoever the SQL says is up.
    let state = await vetoState(match.id);
    expect(state.veto_type).toBe("Pick");
    const picker = state.picking!;
    await insertPick(match.id, "Pick", picker, match.mapIds[1]);

    // A Pick alone creates no map: the opposing side choice completes it.
    let maps = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(maps.length).toBe(0);

    // Step 3: Side — must be the other lineup, and a side is mandatory.
    state = await vetoState(match.id);
    expect(state.veto_type).toBe("Side");
    const sider =
      picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
    expect(state.picking).toBe(sider);

    await expect(
      insertPick(match.id, "Side", sider, match.mapIds[1]),
    ).rejects.toThrow(/Must pick a side/i);

    await insertPick(match.id, "Side", sider, match.mapIds[1], "CT");

    const [map] = await postgres.query<
      Array<{ map_id: string; lineup_1_side: string; lineup_2_side: string }>
    >(
      "SELECT map_id, lineup_1_side, lineup_2_side FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(map.map_id).toBe(match.mapIds[1]);
    // The side chooser gets the side they asked for.
    if (sider === match.lineup_1_id) {
      expect(map.lineup_1_side).toBe("CT");
      expect(map.lineup_2_side).toBe("TERRORIST");
    } else {
      expect(map.lineup_2_side).toBe("CT");
      expect(map.lineup_1_side).toBe("TERRORIST");
    }
  });

  it("deleting a veto pick removes the map it created", async () => {
    const match = await createVetoMatch(3, 4);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    const picker = (await vetoState(match.id)).picking!;
    await insertPick(match.id, "Pick", picker, match.mapIds[1]);
    const sider =
      picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
    await insertPick(match.id, "Side", sider, match.mapIds[1], "CT");

    await postgres.query(
      "DELETE FROM match_map_veto_picks WHERE match_id = $1 AND map_id = $2",
      [match.id, match.mapIds[1]],
    );

    const maps = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(maps.length).toBe(0);
  });

  it("cancelling a match mid-veto wipes its veto picks", async () => {
    const match = await createVetoMatch(1, 3);
    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);

    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [match.id],
    );

    const picks = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_map_veto_picks WHERE match_id = $1",
      [match.id],
    );
    expect(picks.length).toBe(0);
  });
});
