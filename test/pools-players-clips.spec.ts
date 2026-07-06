import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Sweeps the remaining small trigger surfaces: map-pool membership sync
// against pending matches (tau__map_pool), the players role/registered-name
// guards (tbau_players), and the match-clip summary counters kept on
// match_maps.
describe("map pools, player guards, and clip counters (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("PoolsPlayersClipsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199700000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  describe("map pool sync (tau__map_pool)", () => {
    it("swapping a pool's map re-syncs pending matches to the new map", async () => {
      const { poolId, mapIds } = await fx.mapPool(1);
      const match = await fx.match({ mapPoolId: poolId });

      const [otherMap] = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM maps WHERE type = 'Competitive' AND id != $1 ORDER BY name LIMIT 1`,
        [mapIds[0]],
      );
      await postgres.query(
        "UPDATE _map_pool SET map_id = $1 WHERE map_pool_id = $2",
        [otherMap.id, poolId],
      );

      const maps = await postgres.query<Array<{ map_id: string }>>(
        "SELECT map_id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(maps.length).toBe(1);
      expect(maps[0].map_id).toBe(otherMap.id);
    });

    it("refuses to shrink a pool below a pending match's best_of", async () => {
      const { poolId, mapIds } = await fx.mapPool(2);
      await fx.match({ mapPoolId: poolId, bestOf: 2 });

      await expect(
        postgres.query(
          "DELETE FROM _map_pool WHERE map_pool_id = $1 AND map_id = $2",
          [poolId, mapIds[0]],
        ),
      ).rejects.toThrow(/Not enough maps in the pool/i);
    });

    it("the update_map_pools settings hook restores seeded pools from the active roster", async () => {
      const seededPool = await fx.seededPool("Competitive");
      const [{ c: before }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM _map_pool WHERE map_pool_id = $1",
        [seededPool],
      );

      await postgres.query(
        `DELETE FROM _map_pool WHERE map_pool_id = $1 AND map_id =
           (SELECT map_id FROM _map_pool WHERE map_pool_id = $1 LIMIT 1)`,
        [seededPool],
      );

      // The trigger fires on settings UPDATE.
      await postgres.query(
        `INSERT INTO settings (name, value) VALUES ('update_map_pools', 'false')
         ON CONFLICT (name) DO NOTHING`,
      );
      await postgres.query(
        "UPDATE settings SET value = 'true' WHERE name = 'update_map_pools'",
      );

      const [{ c: after }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM _map_pool WHERE map_pool_id = $1",
        [seededPool],
      );
      expect(Number(after)).toBe(Number(before));
    });

    it("does not disturb a Live match's maps", async () => {
      const { poolId, mapIds } = await fx.mapPool(1);
      const match = await fx.match({ mapPoolId: poolId });
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
        match.id,
      ]);

      const [otherMap] = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM maps WHERE type = 'Competitive' AND id != $1 ORDER BY name LIMIT 1`,
        [mapIds[0]],
      );
      await postgres.query(
        "UPDATE _map_pool SET map_id = $1 WHERE map_pool_id = $2",
        [otherMap.id, poolId],
      );

      const maps = await postgres.query<Array<{ map_id: string }>>(
        "SELECT map_id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(maps[0].map_id).toBe(mapIds[0]);
    });
  });

  describe("player guards (tbau_players)", () => {
    it("a registered name cannot be claimed twice", async () => {
      const first = await fx.player();
      await postgres.query(
        "UPDATE players SET name = 'TakenName', name_registered = true WHERE steam_id = $1",
        [first],
      );

      const second = await fx.player();
      await expect(
        postgres.query(
          "UPDATE players SET name = 'TakenName', name_registered = true WHERE steam_id = $1",
          [second],
        ),
      ).rejects.toThrow(/already registered/i);

      // Unregistered duplicates remain allowed.
      await postgres.query("UPDATE players SET name = 'TakenName' WHERE steam_id = $1", [
        second,
      ]);
    });

    it("nobody can touch the role of a player at or above their own", async () => {
      const moderator = await fx.player();
      await postgres.query(
        "UPDATE players SET role = 'moderator' WHERE steam_id = $1",
        [moderator],
      );
      const admin = await fx.player();
      await postgres.query("UPDATE players SET role = 'administrator' WHERE steam_id = $1", [
        admin,
      ]);

      await expect(
        runAsUser(postgres, moderator, "moderator", (query) =>
          query("UPDATE players SET role = 'user' WHERE steam_id = $1", [admin]),
        ),
      ).rejects.toThrow(/above your own/i);
    });

    it("nobody can promote a player beyond their own role", async () => {
      const moderator = await fx.player();
      await postgres.query(
        "UPDATE players SET role = 'moderator' WHERE steam_id = $1",
        [moderator],
      );
      const pleb = await fx.player();

      await expect(
        runAsUser(postgres, moderator, "moderator", (query) =>
          query("UPDATE players SET role = 'administrator' WHERE steam_id = $1", [pleb]),
        ),
      ).rejects.toThrow(/higher than yourself/i);

      // Promoting within their ceiling works.
      await runAsUser(postgres, moderator, "moderator", (query) =>
        query("UPDATE players SET role = 'verified_user' WHERE steam_id = $1", [
          pleb,
        ]),
      );
      const [row] = await postgres.query<Array<{ role: string }>>(
        "SELECT role FROM players WHERE steam_id = $1",
        [pleb],
      );
      expect(row.role).toBe("verified_user");
    });
  });

  describe("clip summary counters", () => {
    const clipSetup = async () => {
      const ctx = await fx.bareMatch();
      const owner = await fx.player();
      return { ...ctx, owner };
    };

    const summary = async (mapId: string) => {
      const [row] = await postgres.query<
        Array<{
          clips_count: number;
          public_clips_count: number;
          latest_clip_at: Date | null;
          public_latest_clip_at: Date | null;
        }>
      >(
        `SELECT clips_count, public_clips_count, latest_clip_at, public_latest_clip_at
         FROM match_maps WHERE id = $1`,
        [mapId],
      );
      return row;
    };

    const addClip = async (
      mapId: string,
      owner: string,
      visibility: "private" | "public",
    ) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_clips (user_steam_id, match_map_id, title, visibility)
         VALUES ($1, $2, 'clip', $3) RETURNING id`,
        [owner, mapId, visibility],
      );
      return row.id;
    };

    it("tracks totals and public counts through insert, publish, and delete", async () => {
      const { mapId, owner } = await clipSetup();

      const privateClip = await addClip(mapId, owner, "private");
      await addClip(mapId, owner, "public");

      let counters = await summary(mapId);
      expect(Number(counters.clips_count)).toBe(2);
      expect(Number(counters.public_clips_count)).toBe(1);
      expect(counters.latest_clip_at).not.toBeNull();
      expect(counters.public_latest_clip_at).not.toBeNull();

      // Publishing the private clip bumps the public count.
      await postgres.query(
        "UPDATE match_clips SET visibility = 'public' WHERE id = $1",
        [privateClip],
      );
      counters = await summary(mapId);
      expect(Number(counters.public_clips_count)).toBe(2);

      // Deleting recomputes from scratch.
      await postgres.query("DELETE FROM match_clips WHERE id = $1", [
        privateClip,
      ]);
      counters = await summary(mapId);
      expect(Number(counters.clips_count)).toBe(1);
      expect(Number(counters.public_clips_count)).toBe(1);
    });
  });
});
