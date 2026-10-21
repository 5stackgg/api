import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// veto_stalled_by: who an expired tournament veto is forfeited against.
describe("veto_stalled_by (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("VetoStalledByTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27016);
    await seedRegionWithServer(postgres, "TestC", 27017);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL, enabled = true",
    );
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
  });

  const vetoMatch = async (
    over: { pool?: number; timeout?: number; regions?: string[] } = {},
  ) => {
    const { poolId, mapIds } = await fx.mapPool(over.pool ?? 7);
    const match = await fx.match({
      bestOf: 3,
      mapVeto: true,
      mapPoolId: poolId,
      vetoPickTimeout: over.timeout ?? 0,
      regions: over.regions ?? ["TestA"],
    });
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    return { ...match, poolId, mapIds };
  };

  const stalledBy = async (matchId: string) => {
    const [row] = await postgres.query<Array<{ lineup: string | null }>>(
      "SELECT veto_stalled_by($1)::text AS lineup",
      [matchId],
    );
    return row.lineup;
  };

  const onTheMapClock = async (matchId: string) => {
    const [{ lineup }] = await postgres.query<Array<{ lineup: string }>>(
      "SELECT get_map_veto_picking_lineup_id(m) AS lineup FROM matches m WHERE id = $1",
      [matchId],
    );
    return lineup;
  };

  // A step taken `ago` back by whoever's turn it is. Half of the default
  // fifteen-minute window is seven and a half minutes.
  const step = async (
    match: { id: string; mapIds: string[] },
    type: "Ban" | "Pick" | "Side",
    mapIndex: number,
    ago = "0 seconds",
  ) => {
    await postgres.query(
      `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, side, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - $6::interval)`,
      [
        match.id,
        type,
        await onTheMapClock(match.id),
        match.mapIds[mapIndex],
        type === "Side" ? "CT" : null,
        ago,
      ],
    );
  };

  const ban = (
    match: { id: string; mapIds: string[] },
    index: number,
    ago?: string,
  ) => step(match, "Ban", index, ago);

  const banRegion = async (
    match: { id: string; lineup_1_id: string },
    region: string,
    ago = "0 seconds",
  ) => {
    await postgres.query(
      `INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region, created_at)
       VALUES ($1, 'Ban', $2, $3, NOW() - $4::interval)`,
      [match.id, match.lineup_1_id, region, ago],
    );
  };

  it("blames the side whose turn it is when the veto has no clock", async () => {
    const match = await vetoMatch();
    await ban(match, 0, "1 hour");

    const waitingOn = await onTheMapClock(match.id);
    expect(waitingOn).toBe(match.lineup_2_id);
    expect(await stalledBy(match.id)).toBe(waitingOn);
  });

  it("blames nobody when the turn only just opened, so holding a turn to the last second can't shift the blame", async () => {
    const match = await vetoMatch();
    await ban(match, 0);

    expect(await stalledBy(match.id)).toBeNull();
  });

  it("blames nobody while a veto clock is running, since it picks for a side that stalls", async () => {
    const match = await vetoMatch({ timeout: 60 });

    expect(await stalledBy(match.id)).toBeNull();
  });

  it("blames the side on the region veto while one is still being chosen", async () => {
    const match = await vetoMatch({ regions: ["TestA", "TestB", "TestC"] });
    await banRegion(match, "TestB", "1 hour");

    expect(await onTheMapClock(match.id)).toBe(match.lineup_1_id);
    expect(await stalledBy(match.id)).toBe(match.lineup_2_id);
  });

  it("blames nobody when only one region can still be banned, since that one locks in by itself", async () => {
    const match = await vetoMatch({ regions: ["TestA", "TestB", "TestC"] });
    await banRegion(match, "TestB", "1 hour");
    await postgres.query(
      "UPDATE servers SET enabled = false WHERE region = 'TestC'",
    );

    expect(await stalledBy(match.id)).toBeNull();
  });

  it("counts a side's turn from the other side's last step when it takes two in a row", async () => {
    const match = await vetoMatch();
    await ban(match, 0, "20 minutes");
    await ban(match, 1, "19 minutes");
    await step(match, "Pick", 2, "18 minutes");
    const sidePicker = await onTheMapClock(match.id);
    await step(match, "Side", 2);

    expect(await onTheMapClock(match.id)).toBe(sidePicker);
    expect(await stalledBy(match.id)).toBe(sidePicker);
  });

  it("doesn't count the placed region Decider as the other side's step", async () => {
    const match = await vetoMatch({ regions: ["TestA", "TestB"] });
    await banRegion(match, "TestB", "20 minutes");

    expect(await onTheMapClock(match.id)).toBe(match.lineup_1_id);
    expect(await stalledBy(match.id)).toBe(match.lineup_1_id);
  });

  it("needs the turn open for half the window: seven minutes isn't, eight is", async () => {
    const early = await vetoMatch();
    await ban(early, 0, "7 minutes");
    expect(await stalledBy(early.id)).toBeNull();

    const late = await vetoMatch();
    await ban(late, 0, "8 minutes");
    expect(await stalledBy(late.id)).toBe(late.lineup_2_id);
  });

  it("uses the match's own auto-cancel window", async () => {
    const match = await vetoMatch();
    await postgres.query(
      `UPDATE match_options SET auto_cancel_duration = 60
       WHERE id = (SELECT match_options_id FROM matches WHERE id = $1)`,
      [match.id],
    );
    await ban(match, 0, "20 minutes");

    expect(await stalledBy(match.id)).toBeNull();
  });

  it("blames nobody once there is no map step to take", async () => {
    const match = await fx.match({
      bestOf: 1,
      mapVeto: false,
      vetoPickTimeout: 0,
    });
    await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
      match.id,
    ]);

    expect(await stalledBy(match.id)).toBeNull();
  });

  it("blames nobody for a match that isn't in the veto", async () => {
    const match = await fx.match({ bestOf: 1, mapVeto: false });

    expect(await stalledBy(match.id)).toBeNull();
  });

  it("blames nobody, rather than failing, when a pool edit leaves the veto unreadable", async () => {
    const match = await vetoMatch({ pool: 5 });
    await ban(match, 0, "2 hours");
    await ban(match, 1, "1 hour");
    await postgres.query(
      "DELETE FROM _map_pool WHERE map_pool_id = $1 AND map_id = $2",
      [match.poolId, match.mapIds[4]],
    );

    await expect(onTheMapClock(match.id)).rejects.toThrow(
      "Side selection requested but no prior Pick exists",
    );
    expect(await stalledBy(match.id)).toBeNull();
  });
});
