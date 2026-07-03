import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures, KillOptions } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the player_kills / player_assists stat-maintenance triggers:
// lifetime aggregates (player_stats, player_kills_by_weapon) and the season
// attribution path (player_season_stats), including the delete/decrement side
// used when a demo is reparsed.
describe("player stats triggers (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerStatsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM seasons");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "DELETE FROM settings WHERE name = 'public.seasons_enabled'",
    );
  });

  const seedPlayer = () => fx.player();

  // A minimal finished match plus one map, enough to attach kill/assist rows.
  const seedMatch = (endedAt: string | null = null) => fx.bareMatch(endedAt);

  const insertKill = (
    ctx: { matchId: string; mapId: string },
    attacker: string,
    victim: string,
    opts: KillOptions = {},
  ) => fx.kill(ctx, attacker, victim, opts);

  const stats = async (steam: string) => {
    const [row] = await postgres.query<
      Array<{
        kills: string;
        deaths: string;
        assists: string;
        headshots: string;
        headshot_percentage: number;
      }>
    >("SELECT * FROM player_stats WHERE player_steam_id = $1", [steam]);
    return row
      ? {
          kills: Number(row.kills),
          deaths: Number(row.deaths),
          assists: Number(row.assists),
          headshots: Number(row.headshots),
          headshotPercentage: row.headshot_percentage,
        }
      : undefined;
  };

  const weaponKills = async (steam: string, weapon: string) => {
    const [row] = await postgres.query<Array<{ kill_count: string }>>(
      'SELECT kill_count FROM player_kills_by_weapon WHERE player_steam_id = $1 AND "with" = $2',
      [steam, weapon],
    );
    return row ? Number(row.kill_count) : undefined;
  };

  describe("lifetime aggregates", () => {
    it("credits the attacker, the victim, and the weapon on a kill", async () => {
      const ctx = await seedMatch();
      const attacker = await seedPlayer();
      const victim = await seedPlayer();

      await insertKill(ctx, attacker, victim, { headshot: true });

      expect(await stats(attacker)).toMatchObject({
        kills: 1,
        deaths: 0,
        headshots: 1,
      });
      expect(await stats(victim)).toMatchObject({ kills: 0, deaths: 1 });
      expect(await weaponKills(attacker, "ak47")).toBe(1);
    });

    it("tracks headshot percentage across accumulated kills", async () => {
      const ctx = await seedMatch();
      const attacker = await seedPlayer();
      const victim = await seedPlayer();
      const victim2 = await seedPlayer();

      await insertKill(ctx, attacker, victim, { headshot: true });
      await insertKill(ctx, attacker, victim2, { headshot: false });

      expect(await stats(attacker)).toMatchObject({
        kills: 2,
        headshots: 1,
        headshotPercentage: 0.5,
      });
    });

    it("deleting a kill decrements stats and prunes zeroed weapon rows", async () => {
      const ctx = await seedMatch();
      const attacker = await seedPlayer();
      const victim = await seedPlayer();

      await insertKill(ctx, attacker, victim, {
        headshot: true,
        weapon: "awp",
      });
      await postgres.query("DELETE FROM player_kills WHERE match_id = $1", [
        ctx.matchId,
      ]);

      expect(await stats(attacker)).toMatchObject({
        kills: 0,
        headshots: 0,
        headshotPercentage: 0,
      });
      expect(await stats(victim)).toMatchObject({ deaths: 0 });
      expect(await weaponKills(attacker, "awp")).toBeUndefined();
    });

    it("never drives stats negative on delete", async () => {
      const ctx = await seedMatch();
      const attacker = await seedPlayer();
      const victim = await seedPlayer();

      await insertKill(ctx, attacker, victim);
      // Simulate an already-zeroed aggregate (e.g. a manual reset) before the
      // source row is deleted out from under it.
      await postgres.query(
        "UPDATE player_stats SET kills = 0, deaths = 0 WHERE player_steam_id IN ($1, $2)",
        [attacker, victim],
      );

      await postgres.query("DELETE FROM player_kills WHERE match_id = $1", [
        ctx.matchId,
      ]);

      expect(await stats(attacker)).toMatchObject({ kills: 0 });
      expect(await stats(victim)).toMatchObject({ deaths: 0 });
    });

    it("assists increment on insert and floor at zero on delete", async () => {
      const ctx = await seedMatch();
      const assister = await seedPlayer();
      const victim = await seedPlayer();

      await fx.assist(ctx, assister, victim);
      expect(await stats(assister)).toMatchObject({ assists: 1 });

      await postgres.query("DELETE FROM player_assists WHERE match_id = $1", [
        ctx.matchId,
      ]);
      expect(await stats(assister)).toMatchObject({ assists: 0 });

      await postgres.query("DELETE FROM player_assists WHERE match_id = $1", [
        ctx.matchId,
      ]);
      expect(await stats(assister)).toMatchObject({ assists: 0 });
    });
  });

  describe("season attribution", () => {
    const D = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toISOString();

    const enableSeasons = () => fx.enableSeasons();

    const createSeason = (start: string, end: string | null) =>
      fx.season(start, end);

    const seasonStats = async (steam: string, seasonId: string) => {
      const [row] = await postgres.query<
        Array<{ kills: string; deaths: string; assists: string }>
      >(
        "SELECT * FROM player_season_stats WHERE player_steam_id = $1 AND season_id = $2",
        [steam, seasonId],
      );
      return row
        ? {
            kills: Number(row.kills),
            deaths: Number(row.deaths),
            assists: Number(row.assists),
          }
        : undefined;
    };

    it("attributes kills to the season covering the match end", async () => {
      await enableSeasons();
      const seasonId = await createSeason(D("2025-01-01"), D("2025-06-01"));
      const ctx = await seedMatch(D("2025-02-15"));
      const attacker = await seedPlayer();
      const victim = await seedPlayer();

      await insertKill(ctx, attacker, victim, {
        headshot: true,
        time: D("2025-02-15"),
      });

      expect(await seasonStats(attacker, seasonId)).toMatchObject({
        kills: 1,
      });
      expect(await seasonStats(victim, seasonId)).toMatchObject({ deaths: 1 });
    });

    it("decrements the same season on delete so reparses stay balanced", async () => {
      await enableSeasons();
      const seasonId = await createSeason(D("2025-01-01"), D("2025-06-01"));
      const ctx = await seedMatch(D("2025-02-15"));
      const attacker = await seedPlayer();
      const victim = await seedPlayer();

      await insertKill(ctx, attacker, victim, { time: D("2025-02-15") });
      await postgres.query("DELETE FROM player_kills WHERE match_id = $1", [
        ctx.matchId,
      ]);

      expect(await seasonStats(attacker, seasonId)).toMatchObject({
        kills: 0,
      });
      // Lifetime stats decremented too.
      expect(await stats(attacker)).toMatchObject({ kills: 0 });
    });

    it("records no season stats for a match outside any season", async () => {
      await enableSeasons();
      await createSeason(D("2025-01-01"), D("2025-06-01"));
      const ctx = await seedMatch(D("2024-06-15")); // before the season
      const attacker = await seedPlayer();
      const victim = await seedPlayer();

      await insertKill(ctx, attacker, victim, { time: D("2024-06-15") });

      const rows = await postgres.query<Array<{ kills: string }>>(
        "SELECT kills FROM player_season_stats WHERE player_steam_id = $1",
        [attacker],
      );
      expect(rows.length).toBe(0);
      expect(await stats(attacker)).toMatchObject({ kills: 1 });
    });

    it("records no season stats when the seasons feature is disabled", async () => {
      const seasonId = await createSeason(D("2025-01-01"), D("2025-06-01"));
      const ctx = await seedMatch(D("2025-02-15"));
      const attacker = await seedPlayer();
      const victim = await seedPlayer();

      await insertKill(ctx, attacker, victim, { time: D("2025-02-15") });

      expect(await seasonStats(attacker, seasonId)).toBeUndefined();
      expect(await stats(attacker)).toMatchObject({ kills: 1 });
    });

    it("attributes assists to the covering season", async () => {
      await enableSeasons();
      const seasonId = await createSeason(D("2025-01-01"), null);
      const ctx = await seedMatch(D("2025-02-15"));
      const assister = await seedPlayer();
      const victim = await seedPlayer();

      await fx.assist(ctx, assister, victim, D("2025-02-15"));

      expect(await seasonStats(assister, seasonId)).toMatchObject({
        assists: 1,
      });
    });
  });
});
