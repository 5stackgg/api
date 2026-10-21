import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// rewind_map_veto and extend_veto_clock: the organizer's Undo Last Step, Fix a
// Mis-pick, Redo the Veto and Give 30s More.
describe("veto rewind (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("VetoRewindTest");
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

  const createVetoMatch = async (regions = ["TestA"]) => {
    const { poolId, mapIds } = await fx.mapPool(7);
    const match = await fx.match({
      bestOf: 3,
      mapVeto: true,
      mapPoolId: poolId,
      regions,
    });
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    return { ...match, mapIds };
  };

  const state = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{
        status: string;
        veto_type: string | null;
        picking: string | null;
        picks: number;
        maps: number;
        server_id: string | null;
        region: string | null;
        veto_pick_expires_at: Date | null;
        cancels_at: Date | null;
      }>
    >(
      `SELECT m.status, get_map_veto_type(m) AS veto_type,
              get_map_veto_picking_lineup_id(m) AS picking,
              (SELECT COUNT(*) FROM match_map_veto_picks WHERE match_id = m.id)::int AS picks,
              (SELECT COUNT(*) FROM match_maps WHERE match_id = m.id)::int AS maps,
              m.server_id, m.region, m.veto_pick_expires_at, m.cancels_at
       FROM matches m WHERE m.id = $1`,
      [matchId],
    );
    return row;
  };

  // Plays the veto forward by whatever the SQL says comes next, `steps` times
  // (or to the end), recording who took each step.
  const play = async (
    match: Awaited<ReturnType<typeof createVetoMatch>>,
    steps = Infinity,
  ) => {
    const taken: Array<{ type: string; lineup: string; mapId: string }> = [];
    const used = new Set(
      (
        await postgres.query<Array<{ map_id: string }>>(
          "SELECT map_id FROM match_map_veto_picks WHERE match_id = $1",
          [match.id],
        )
      ).map((row) => row.map_id),
    );
    let lastPicked: string | null = null;

    while (taken.length < steps) {
      const now = await state(match.id);
      if (now.status !== "Veto" || !now.veto_type || !now.region) {
        break;
      }
      if (now.veto_type === "Side") {
        await postgres.query(
          `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, side)
           VALUES ($1, 'Side', $2, $3, 'CT')`,
          [match.id, now.picking, lastPicked],
        );
        taken.push({ type: "Side", lineup: now.picking!, mapId: lastPicked! });
        continue;
      }
      const mapId = match.mapIds.find((id) => !used.has(id))!;
      used.add(mapId);
      if (now.veto_type === "Pick") {
        lastPicked = mapId;
      }
      await postgres.query(
        `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
         VALUES ($1, $2, $3, $4)`,
        [match.id, now.veto_type, now.picking, mapId],
      );
      taken.push({ type: now.veto_type, lineup: now.picking!, mapId });
    }
    return taken;
  };

  const rewind = async (matchId: string, step: number, expected?: number) => {
    const [row] = await postgres.query<Array<{ server_id: string | null }>>(
      "SELECT rewind_map_veto($1, $2, $3)::text AS server_id",
      [matchId, step, expected ?? null],
    );
    return row.server_id;
  };

  const banRegion = (
    match: { id: string; lineup_1_id: string },
    region: string,
  ) =>
    postgres.query(
      `INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region)
       VALUES ($1, 'Ban', $2, $3)`,
      [match.id, match.lineup_1_id, region],
    );

  const withAutoCancel = (matchId: string, on: boolean) =>
    postgres.query(
      `UPDATE match_options SET auto_cancellation = $2, auto_cancel_duration = 15
       WHERE id = (SELECT match_options_id FROM matches WHERE id = $1)`,
      [matchId, on],
    );

  it("takes back a step and everything after it, and gives the turn back", async () => {
    const match = await createVetoMatch();
    const taken = await play(match, 5);
    expect(taken.map((step) => step.type)).toEqual([
      "Ban",
      "Ban",
      "Pick",
      "Side",
      "Pick",
    ]);

    await rewind(match.id, 3);

    const now = await state(match.id);
    expect(now.status).toBe("Veto");
    expect(now.picks).toBe(2);
    expect(now.veto_type).toBe("Pick");
    expect(now.picking).toBe(taken[2].lineup);
    expect(now.maps).toBe(0);
  });

  it("drops the map a side was chosen for when the side is taken back", async () => {
    const match = await createVetoMatch();
    await play(match, 4);
    expect((await state(match.id)).maps).toBe(1);

    await rewind(match.id, 4);

    const now = await state(match.id);
    expect(now.picks).toBe(3);
    expect(now.veto_type).toBe("Side");
    expect(now.maps).toBe(0);
  });

  it("redoes the whole veto from the first ban", async () => {
    const match = await createVetoMatch();
    const taken = await play(match, 6);

    await rewind(match.id, 1);

    const now = await state(match.id);
    expect(now.picks).toBe(0);
    expect(now.maps).toBe(0);
    expect(now.veto_type).toBe("Ban");
    expect(now.picking).toBe(taken[0].lineup);
  });

  it("re-arms the clock for the team whose turn it is", async () => {
    const match = await createVetoMatch();
    await play(match, 3);
    await postgres.query(
      "UPDATE matches SET veto_pick_expires_at = NOW() - interval '1 minute' WHERE id = $1",
      [match.id],
    );

    await rewind(match.id, 2);

    const now = await state(match.id);
    expect(now.veto_pick_expires_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it("takes a finished veto back to Veto before the first map starts, releasing the server", async () => {
    const match = await createVetoMatch();
    await play(match);
    const done = await state(match.id);
    expect(done.status).toBe("Live");
    expect(done.maps).toBe(3);

    const [server] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM servers LIMIT 1",
    );
    await postgres.query("UPDATE matches SET server_id = $1 WHERE id = $2", [
      server.id,
      match.id,
    ]);
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
      [match.id, server.id],
    );

    expect(await rewind(match.id, 5)).toBe(server.id);

    const now = await state(match.id);
    expect(now.status).toBe("Veto");
    expect(now.picks).toBe(4);
    expect(now.maps).toBe(1);
    expect(now.server_id).toBeNull();
    expect(now.region).toBe(done.region);
    const [released] = await postgres.query<
      Array<{ reserved_by_match_id: string | null }>
    >("SELECT reserved_by_match_id FROM servers WHERE id = $1", [server.id]);
    expect(released.reserved_by_match_id).toBeNull();
  });

  it("takes back the ban that left one map when the Decider is chosen", async () => {
    const match = await createVetoMatch();
    const taken = await play(match);
    expect(taken).toHaveLength(8);
    expect((await state(match.id)).picks).toBe(9);

    await rewind(match.id, 9);

    const now = await state(match.id);
    expect(now.status).toBe("Veto");
    expect(now.picks).toBe(7);
    expect(now.veto_type).toBe("Ban");
    expect(now.picking).toBe(taken[7].lineup);
    expect(now.maps).toBe(2);

    await play(match);
    const replayed = await state(match.id);
    expect(replayed.status).toBe("Live");
    expect(replayed.picks).toBe(9);
    expect(replayed.maps).toBe(3);
  });

  it("hands back no server when the veto was still running", async () => {
    const match = await createVetoMatch();
    await play(match, 3);

    expect(await rewind(match.id, 2)).toBeNull();
  });

  it("refuses when a step was taken since the organizer looked", async () => {
    const match = await createVetoMatch();
    await play(match, 3);

    await expect(rewind(match.id, 3, 2)).rejects.toThrow(
      "The veto has moved on since you looked",
    );
    expect((await state(match.id)).picks).toBe(3);

    await rewind(match.id, 3, 3);
    expect((await state(match.id)).picks).toBe(2);
  });

  it("puts back the region the teams vetoed when the map veto is redone", async () => {
    const match = await createVetoMatch(["TestA", "TestB"]);
    expect((await state(match.id)).region).toBeNull();
    await banRegion(match, "TestB");
    expect((await state(match.id)).region).toBe("TestA");
    await play(match);
    expect((await state(match.id)).status).toBe("Live");

    await rewind(match.id, 5);

    const now = await state(match.id);
    expect(now.status).toBe("Veto");
    expect(now.region).toBe("TestA");

    await play(match);
    expect((await state(match.id)).status).toBe("Live");
  });

  it("leaves a vetoed region that lost its servers for one that can host", async () => {
    const match = await createVetoMatch(["TestA", "TestB"]);
    await banRegion(match, "TestB");
    await play(match);
    await postgres.query(
      "UPDATE servers SET enabled = false WHERE region = 'TestA'",
    );

    await rewind(match.id, 5);

    const now = await state(match.id);
    expect(now.status).toBe("Veto");
    expect(now.region).toBe("TestB");

    await play(match);
    expect((await state(match.id)).status).toBe("Live");
  });

  it("lets the teams veto the regions again when theirs lost its servers and several still can host", async () => {
    const match = await createVetoMatch(["TestA", "TestB", "TestC"]);
    const banRegionInTurn = async (region: string) => {
      const [{ lineup }] = await postgres.query<Array<{ lineup: string }>>(
        "SELECT get_region_veto_picking_lineup_id(m) AS lineup FROM matches m WHERE id = $1",
        [match.id],
      );
      await postgres.query(
        `INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region)
         VALUES ($1, 'Ban', $2, $3)`,
        [match.id, lineup, region],
      );
    };
    await banRegionInTurn("TestB");
    await banRegionInTurn("TestC");
    expect((await state(match.id)).region).toBe("TestA");
    await play(match);
    await postgres.query(
      "UPDATE servers SET enabled = false WHERE region = 'TestA'",
    );

    await rewind(match.id, 5);

    const now = await state(match.id);
    expect(now.status).toBe("Veto");
    expect(now.region).toBeNull();
    const [{ count }] = await postgres.query<Array<{ count: number }>>(
      "SELECT COUNT(*)::int AS count FROM match_region_veto_picks WHERE match_id = $1",
      [match.id],
    );
    expect(count).toBe(0);

    await banRegionInTurn("TestB");
    expect((await state(match.id)).region).toBe("TestC");
    await play(match);
    expect((await state(match.id)).status).toBe("Live");
  });

  it("gives a redone veto and an extended clock a fresh auto-cancel window", async () => {
    const match = await createVetoMatch();
    await withAutoCancel(match.id, true);
    await play(match, 6);
    const soon = () =>
      postgres.query(
        "UPDATE matches SET cancels_at = NOW() + interval '1 minute' WHERE id = $1",
        [match.id],
      );
    const fresh = Date.now() + 14 * 60_000;

    await soon();
    await rewind(match.id, 1);
    expect((await state(match.id)).cancels_at!.getTime()).toBeGreaterThan(
      fresh,
    );

    await soon();
    await postgres.query("SELECT extend_veto_clock($1, 600)", [match.id]);
    expect((await state(match.id)).cancels_at!.getTime()).toBeGreaterThan(
      fresh,
    );
  });

  it("leaves auto-cancel alone on matches that don't use it", async () => {
    const match = await createVetoMatch();
    await withAutoCancel(match.id, false);
    await play(match, 3);
    await postgres.query("UPDATE matches SET cancels_at = NULL WHERE id = $1", [
      match.id,
    ]);

    await rewind(match.id, 1);
    await postgres.query("SELECT extend_veto_clock($1, 30)", [match.id]);

    expect((await state(match.id)).cancels_at).toBeNull();
  });

  it("refuses once the first map has started", async () => {
    const match = await createVetoMatch();
    await play(match);
    await postgres.query(
      `UPDATE match_maps SET status = 'Warmup'
       WHERE match_id = $1 AND "order" = 1`,
      [match.id],
    );

    await expect(rewind(match.id, 3)).rejects.toThrow(
      "The first map has already started",
    );
    expect((await state(match.id)).picks).toBe(9);
  });

  it("refuses steps that haven't been taken", async () => {
    const match = await createVetoMatch();
    await play(match, 2);

    await expect(rewind(match.id, 0)).rejects.toThrow(
      "That veto step has not been taken",
    );
    await expect(rewind(match.id, 3)).rejects.toThrow(
      "That veto step has not been taken",
    );
    expect((await state(match.id)).picks).toBe(2);
  });

  it("refuses matches without a map veto, and ones that are over", async () => {
    const plain = await fx.match({ bestOf: 1, mapVeto: false });
    await expect(rewind(plain.id, 1)).rejects.toThrow(
      "This match has no map veto",
    );

    const match = await createVetoMatch();
    await play(match, 2);
    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [match.id],
    );
    await expect(rewind(match.id, 1)).rejects.toThrow(
      "The veto can only be changed before the first map starts",
    );
  });

  describe("extend_veto_clock", () => {
    const extend = (matchId: string, seconds: number) =>
      postgres.query<Array<{ expires_at: Date }>>(
        "SELECT extend_veto_clock($1, $2) AS expires_at",
        [matchId, seconds],
      );

    it("adds time to the running clock", async () => {
      const match = await createVetoMatch();
      const before = (await state(match.id)).veto_pick_expires_at!;

      const [{ expires_at }] = await extend(match.id, 30);

      expect(expires_at.getTime() - before.getTime()).toBe(30_000);
      expect((await state(match.id)).veto_pick_expires_at!.getTime()).toBe(
        expires_at.getTime(),
      );
    });

    it("starts from now when the clock already ran out", async () => {
      const match = await createVetoMatch();
      await postgres.query(
        "UPDATE matches SET veto_pick_expires_at = NOW() - interval '1 minute' WHERE id = $1",
        [match.id],
      );

      const [{ expires_at }] = await extend(match.id, 30);

      expect(expires_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    });

    it("refuses when no veto clock is running, and silly amounts", async () => {
      const match = await createVetoMatch();
      await expect(extend(match.id, 0)).rejects.toThrow(
        "Add between 1 and 600 seconds",
      );
      await expect(extend(match.id, 601)).rejects.toThrow(
        "Add between 1 and 600 seconds",
      );

      await play(match);
      await expect(extend(match.id, 30)).rejects.toThrow(
        "The veto clock is not running",
      );
    });
  });
});
