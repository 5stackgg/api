import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the veto pick timer SQL: matches.veto_pick_expires_at lifecycle
// (armed on entering Veto, refreshed by every pick, cleared on the way out),
// match_options.veto_pick_timeout as the per-match duration with 0 disabling it,
// and auto_pick_expired_veto's fencing token / per-match error isolation.
describe("veto pick timeout (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("VetoTimeoutTest");
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
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("UPDATE servers SET enabled = true");
  });

  // A map-veto match sitting in Veto. Single region so the region veto is
  // already resolved and only map picks are outstanding.
  const createMapVetoMatch = async (
    poolSize: number,
    { bestOf = 1, vetoPickTimeout = 60 } = {},
  ) => {
    const { poolId, mapIds } = await fx.mapPool(poolSize);
    const match = await fx.match({
      bestOf,
      mapVeto: true,
      mapPoolId: poolId,
      vetoPickTimeout,
    });
    // tbu_matches redirects Live to Veto while maps are missing.
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    return { ...match, mapIds };
  };

  const createRegionVetoMatch = async ({ vetoPickTimeout = 60 } = {}) => {
    const { poolId } = await fx.mapPool(1);
    const match = await fx.match({
      regions: ["TestA", "TestB", "TestC"],
      mapVeto: false,
      mapPoolId: poolId,
      vetoPickTimeout,
    });
    await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
      match.id,
    ]);
    return match;
  };

  const matchRow = async (id: string) => {
    const [row] = await postgres.query<
      Array<{
        status: string;
        region: string | null;
        veto_pick_expires_at: Date | null;
      }>
    >(
      "SELECT status, region, veto_pick_expires_at FROM matches WHERE id = $1",
      [id],
    );
    return row;
  };

  const expire = (id: string) =>
    postgres.query(
      "UPDATE matches SET veto_pick_expires_at = NOW() - interval '1 second' WHERE id = $1",
      [id],
    );

  const autoPick = (
    id: string | null = null,
    pickCount: number | null = null,
  ) =>
    postgres.query("SELECT auto_pick_expired_veto($1::uuid, $2::int)", [
      id,
      pickCount,
    ]);

  const mapPicks = (id: string) =>
    postgres.query<
      Array<{ type: string; map_id: string; auto_picked: boolean }>
    >(
      `SELECT type, map_id, auto_picked FROM match_map_veto_picks
       WHERE match_id = $1 ORDER BY created_at ASC`,
      [id],
    );

  const regionPicks = (id: string) =>
    postgres.query<
      Array<{ type: string; region: string; auto_picked: boolean }>
    >(
      `SELECT type, region, auto_picked FROM match_region_veto_picks
       WHERE match_id = $1 ORDER BY created_at ASC`,
      [id],
    );

  const secondsUntil = (at: Date | null) =>
    at === null ? null : (at.getTime() - Date.now()) / 1000;

  describe("deadline lifecycle", () => {
    it("arms the deadline from the match's own timeout when entering Veto", async () => {
      const match = await createMapVetoMatch(3, { vetoPickTimeout: 45 });
      const row = await matchRow(match.id);

      expect(row.status).toBe("Veto");
      expect(secondsUntil(row.veto_pick_expires_at)).toBeGreaterThan(40);
      expect(secondsUntil(row.veto_pick_expires_at)).toBeLessThanOrEqual(45);
    });

    it("leaves the deadline null when the timeout is 0", async () => {
      const match = await createMapVetoMatch(3, { vetoPickTimeout: 0 });
      const row = await matchRow(match.id);

      expect(row.status).toBe("Veto");
      expect(row.veto_pick_expires_at).toBeNull();
    });

    it("does not auto-pick a match whose timer is disabled", async () => {
      const match = await createMapVetoMatch(3, { vetoPickTimeout: 0 });

      // Even a full sweep can't see it: there is no deadline to expire.
      await autoPick();

      expect(await mapPicks(match.id)).toHaveLength(0);
      expect((await matchRow(match.id)).status).toBe("Veto");
    });

    it("pushes the deadline forward on every pick", async () => {
      const match = await createMapVetoMatch(4, { bestOf: 1 });
      const before = await matchRow(match.id);

      // Wind it down so a refresh is unambiguous.
      await postgres.query(
        "UPDATE matches SET veto_pick_expires_at = NOW() + interval '5 seconds' WHERE id = $1",
        [match.id],
      );

      await postgres.query(
        `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
         VALUES ($1, 'Ban', $2, $3)`,
        [match.id, match.lineup_1_id, match.mapIds[0]],
      );

      const after = await matchRow(match.id);
      expect(secondsUntil(after.veto_pick_expires_at)).toBeGreaterThan(50);
      expect(after.veto_pick_expires_at!.getTime()).toBeGreaterThan(
        before.veto_pick_expires_at!.getTime() - 1000,
      );
    });

    it("clears the deadline when the veto completes and the match goes Live", async () => {
      const match = await createMapVetoMatch(2, { bestOf: 1 });

      // One ban leaves a single map, so create_match_map_from_veto inserts the
      // Decider and flips the match to Live.
      await postgres.query(
        `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
         VALUES ($1, 'Ban', $2, $3)`,
        [match.id, match.lineup_1_id, match.mapIds[0]],
      );

      const row = await matchRow(match.id);
      expect(row.status).toBe("Live");
      expect(row.veto_pick_expires_at).toBeNull();
    });

    it("clears the deadline when the match is canceled", async () => {
      const match = await createMapVetoMatch(3);

      await postgres.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        [match.id],
      );

      expect((await matchRow(match.id)).veto_pick_expires_at).toBeNull();
    });

    it("reschedules when the timeout is edited mid-veto", async () => {
      const match = await createMapVetoMatch(3, { vetoPickTimeout: 30 });

      await postgres.query(
        "UPDATE match_options SET veto_pick_timeout = 200 WHERE id = $1",
        [match.options_id],
      );

      const seconds = secondsUntil(
        (await matchRow(match.id)).veto_pick_expires_at,
      );
      expect(seconds).toBeGreaterThan(190);
      expect(seconds).toBeLessThanOrEqual(200);
    });

    it("drops the deadline when the timeout is disabled mid-veto", async () => {
      const match = await createMapVetoMatch(3, { vetoPickTimeout: 30 });

      await postgres.query(
        "UPDATE match_options SET veto_pick_timeout = 0 WHERE id = $1",
        [match.options_id],
      );

      expect((await matchRow(match.id)).veto_pick_expires_at).toBeNull();
    });
  });

  describe("auto picking", () => {
    it("bans a region for the lineup that ran out of time", async () => {
      const match = await createRegionVetoMatch();
      await expire(match.id);

      await autoPick(match.id);

      const picks = await regionPicks(match.id);
      expect(picks).toHaveLength(1);
      expect(picks[0].type).toBe("Ban");
      expect(picks[0].auto_picked).toBe(true);
      expect(["TestA", "TestB", "TestC"]).toContain(picks[0].region);

      // The insert trigger re-armed the timer for the other lineup.
      expect(
        secondsUntil((await matchRow(match.id)).veto_pick_expires_at),
      ).toBeGreaterThan(50);
    });

    it("picks the correct veto type for the pattern position", async () => {
      const match = await createMapVetoMatch(4, { bestOf: 1 });
      await expire(match.id);

      await autoPick(match.id);

      const picks = await mapPicks(match.id);
      expect(picks).toHaveLength(1);
      // Bo1 over a 4 map pool is Ban, Ban, Ban, Decider.
      expect(picks[0].type).toBe("Ban");
      expect(picks[0].auto_picked).toBe(true);
    });

    it("marks only the auto picks, not the human ones", async () => {
      const match = await createMapVetoMatch(4, { bestOf: 1 });

      await postgres.query(
        `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
         VALUES ($1, 'Ban', $2, $3)`,
        [match.id, match.lineup_1_id, match.mapIds[0]],
      );
      await expire(match.id);
      await autoPick(match.id);

      const picks = await mapPicks(match.id);
      expect(picks).toHaveLength(2);
      expect(picks[0].auto_picked).toBe(false);
      expect(picks[1].auto_picked).toBe(true);
    });

    it("drives a whole Bo1 to Live on auto picks alone", async () => {
      const match = await createMapVetoMatch(4, { bestOf: 1 });

      for (let i = 0; i < 5; i++) {
        const row = await matchRow(match.id);
        if (row.status !== "Veto") {
          break;
        }
        await expire(match.id);
        await autoPick(match.id);
      }

      const row = await matchRow(match.id);
      expect(row.status).toBe("Live");
      expect(row.veto_pick_expires_at).toBeNull();

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(Number(count)).toBe(1);
    });

    it("never bans the last available region", async () => {
      const match = await createRegionVetoMatch();

      // Two bans resolve the third region via auto_select_region_veto.
      for (let i = 0; i < 4; i++) {
        const row = await matchRow(match.id);
        if (row.region) {
          break;
        }
        await expire(match.id);
        await autoPick(match.id);
      }

      const row = await matchRow(match.id);
      expect(row.region).not.toBeNull();
      // map_veto is off, so locking the region takes the match Live.
      expect(row.status).toBe("Live");
    });
  });

  describe("fencing token", () => {
    it("ignores a timer armed for an earlier turn", async () => {
      const match = await createMapVetoMatch(4, { bestOf: 1 });

      await postgres.query(
        `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
         VALUES ($1, 'Ban', $2, $3)`,
        [match.id, match.lineup_1_id, match.mapIds[0]],
      );
      await expire(match.id);

      // The job was armed when no picks existed; one has since landed.
      await autoPick(match.id, 0);

      expect(await mapPicks(match.id)).toHaveLength(1);
    });

    it("acts when the token still matches the current turn", async () => {
      const match = await createMapVetoMatch(4, { bestOf: 1 });
      await expire(match.id);

      await autoPick(match.id, 0);

      expect(await mapPicks(match.id)).toHaveLength(1);
    });

    it("counts region and map picks in one sequence", async () => {
      const { poolId } = await fx.mapPool(4);
      const match = await fx.match({
        bestOf: 1,
        mapVeto: true,
        mapPoolId: poolId,
        regions: ["TestA", "TestB", "TestC"],
      });
      await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
        match.id,
      ]);

      // Two region bans, then the Decider auto-inserted by the region veto.
      for (let i = 0; i < 4; i++) {
        if ((await matchRow(match.id)).region) {
          break;
        }
        await expire(match.id);
        await autoPick(match.id);
      }

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT veto_pick_count($1) AS count",
        [match.id],
      );
      const regions = await regionPicks(match.id);
      expect(Number(count)).toBe(regions.length);
      expect(Number(count)).toBeGreaterThan(0);

      // A token from before the region veto must not fire a map pick.
      await expire(match.id);
      await autoPick(match.id, 0);
      expect(await mapPicks(match.id)).toHaveLength(0);
    });
  });

  describe("sweep isolation", () => {
    it("still picks for healthy matches when another is unpickable", async () => {
      const healthy = await createMapVetoMatch(4, { bestOf: 1 });

      // Veto with no veto steps left to take: map veto off and the region
      // already locked in, so get_map_veto_type returns null.
      const { poolId } = await fx.mapPool(1);
      const stuck = await fx.match({ mapVeto: false, mapPoolId: poolId });
      await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
        stuck.id,
      ]);

      await expire(healthy.id);
      await expire(stuck.id);

      await autoPick();

      expect(await mapPicks(healthy.id)).toHaveLength(1);
      // Cleared rather than left expired, so the sweep does not reprocess it
      // on every pass for the rest of the match's life.
      expect((await matchRow(stuck.id)).veto_pick_expires_at).toBeNull();
    });

    it("clears the deadline of a match it cannot act on", async () => {
      const { poolId } = await fx.mapPool(1);
      const stuck = await fx.match({ mapVeto: false, mapPoolId: poolId });
      await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
        stuck.id,
      ]);
      await expire(stuck.id);

      await autoPick();
      expect((await matchRow(stuck.id)).veto_pick_expires_at).toBeNull();

      // Second pass has nothing left to find.
      await autoPick();
      expect((await matchRow(stuck.id)).veto_pick_expires_at).toBeNull();
    });

    it("only touches the requested match when given an id", async () => {
      const a = await createMapVetoMatch(4, { bestOf: 1 });
      const b = await createMapVetoMatch(4, { bestOf: 1 });

      await expire(a.id);
      await expire(b.id);

      await autoPick(a.id);

      expect(await mapPicks(a.id)).toHaveLength(1);
      expect(await mapPicks(b.id)).toHaveLength(0);
    });
  });
});
