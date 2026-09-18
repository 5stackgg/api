import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The FACEIT and Premier leaderboard categories. Unlike every other category
// these are point-in-time ratings held on players rather than anything derived
// from our own matches, so the window, season and source filters do not apply
// to them - they must be ignored rather than silently emptying the board.
describe("external rank leaderboard (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ExternalRankLeaderboardTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196200000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM players");
  });

  const withRanks = async (ranks: {
    name?: string;
    faceitElo?: number | null;
    faceitLevel?: number | null;
    premierRank?: number | null;
  }) => {
    const steamId = await fx.player(ranks.name);
    await postgres.query(
      `UPDATE players
          SET faceit_elo = $2,
              faceit_skill_level = $3,
              premier_rank = $4
        WHERE steam_id = $1::bigint`,
      [
        steamId,
        ranks.faceitElo ?? null,
        ranks.faceitLevel ?? null,
        ranks.premierRank ?? null,
      ],
    );
    return steamId;
  };

  type Entry = {
    player_steam_id: string;
    player_name: string;
    value: number;
    secondary_value: number | null;
    matches_played: number | null;
  };

  const board = (category: string, windowDays = 0, seasonId?: string) =>
    postgres.query<Array<Entry>>(
      `SELECT player_steam_id, player_name, value, secondary_value, matches_played
         FROM get_leaderboard($1, $2, NULL, false, NULL, $3::uuid, 'overall')`,
      [category, windowDays, seasonId ?? null],
    );

  describe("faceit_elo", () => {
    it("ranks players by their faceit rating, highest first", async () => {
      await withRanks({ faceitElo: 1200, faceitLevel: 5 });
      const best = await withRanks({ faceitElo: 3000, faceitLevel: 10 });
      await withRanks({ faceitElo: 2000, faceitLevel: 8 });

      const rows = await board("faceit_elo");

      expect(rows.map((row) => row.value)).toEqual([3000, 2000, 1200]);
      expect(rows[0].player_steam_id).toBe(best);
    });

    it("carries the skill level as the second column", async () => {
      await withRanks({ faceitElo: 2500, faceitLevel: 9 });

      const [row] = await board("faceit_elo");

      expect(row.secondary_value).toBe(9);
    });

    it("leaves out players with no faceit rating", async () => {
      await fx.player();
      await withRanks({ premierRank: 15000 });
      await withRanks({ faceitElo: 1000 });

      expect(await board("faceit_elo")).toHaveLength(1);
    });

    it("ignores the window, because a rating is not a match statistic", async () => {
      await withRanks({ faceitElo: 1800 });

      // a 7 day window would otherwise empty a board of players who have not
      // played on 5stack this week
      expect(await board("faceit_elo", 7)).toHaveLength(1);
    });
  });

  describe("premier_rank", () => {
    it("ranks players by their premier rank, highest first", async () => {
      await withRanks({ premierRank: 12000 });
      const best = await withRanks({ premierRank: 24000 });

      const rows = await board("premier_rank");

      expect(rows.map((row) => row.value)).toEqual([24000, 12000]);
      expect(rows[0].player_steam_id).toBe(best);
    });

    it("treats an unplaced rank of zero as no rank at all", async () => {
      // the demo importer writes 0 for a player who has not placed; ranked as
      // a number it would sort as the worst rating in the game
      await withRanks({ premierRank: 0 });

      expect(await board("premier_rank")).toHaveLength(0);
    });

    it("leaves out players with no premier rank", async () => {
      await fx.player();
      await withRanks({ faceitElo: 2000 });

      expect(await board("premier_rank")).toHaveLength(0);
    });

    it("reports no match count, which it has no way to know", async () => {
      await withRanks({ premierRank: 20000 });

      const [row] = await board("premier_rank");

      expect(row.matches_played).toBe(0);
    });
  });

  it("gives a player their rank on an external board", async () => {
    await withRanks({ faceitElo: 3000 });
    const middle = await withRanks({ faceitElo: 2000 });
    await withRanks({ faceitElo: 1000 });

    const [row] = await postgres.query<Array<{ rank: number; total: number }>>(
      `SELECT rank, total
         FROM get_player_leaderboard_rank('faceit_elo', 0, $1, NULL, false, NULL, 'overall')`,
      [middle],
    );

    expect(row.rank).toBe(2);
    expect(row.total).toBe(3);
  });
});
