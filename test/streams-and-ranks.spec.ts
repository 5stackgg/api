import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the match-stream priority reordering trigger (taud_match_streams)
// and the premier-rank history rollback trigger (players.premier_rank follows
// the latest remaining observation when history rows are removed).
describe("stream priorities and premier rank history (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("StreamsRanksTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199900000000n);
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

  describe("match stream priorities", () => {
    const setup = async () => {
      const match = await fx.match();
      const ids: Array<string> = [];
      for (let priority = 1; priority <= 3; priority++) {
        const [row] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO match_streams (match_id, link, title, priority)
           VALUES ($1, $2, $2, $3) RETURNING id`,
          [match.id, `https://example.test/stream-${priority}`, priority],
        );
        ids.push(row.id);
      }
      return { matchId: match.id, ids };
    };

    const order = async (matchId: string) =>
      (
        await postgres.query<Array<{ id: string; priority: number }>>(
          "SELECT id, priority FROM match_streams WHERE match_id = $1 ORDER BY priority",
          [matchId],
        )
      ).map((s) => s.id);

    it("moving a stream up pushes the displaced streams down", async () => {
      const { matchId, ids } = await setup();
      await postgres.query(
        "UPDATE match_streams SET priority = 1 WHERE id = $1",
        [ids[2]],
      );
      expect(await order(matchId)).toEqual([ids[2], ids[0], ids[1]]);
    });

    it("moving a stream down pulls the others up", async () => {
      const { matchId, ids } = await setup();
      await postgres.query(
        "UPDATE match_streams SET priority = 3 WHERE id = $1",
        [ids[0]],
      );
      expect(await order(matchId)).toEqual([ids[1], ids[2], ids[0]]);
    });

    it("deleting a stream compacts the remaining priorities", async () => {
      const { matchId, ids } = await setup();
      await postgres.query("DELETE FROM match_streams WHERE id = $1", [ids[1]]);

      const rows = await postgres.query<
        Array<{ id: string; priority: number }>
      >(
        "SELECT id, priority FROM match_streams WHERE match_id = $1 ORDER BY priority",
        [matchId],
      );
      expect(rows.map((r) => [r.id, Number(r.priority)])).toEqual([
        [ids[0], 1],
        [ids[2], 2],
      ]);
    });
  });

  describe("premier rank history", () => {
    it("deleting observations rolls players.premier_rank back to the latest remaining one", async () => {
      const player = await fx.player();

      // One observation per match (unique per steam_id + match_id + rank_type).
      const insertObservation = async (rank: number, daysAgo: number) => {
        const { matchId } = await fx.bareMatch();
        const [row] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO player_premier_rank_history (steam_id, rank, match_id, observed_at)
           VALUES ($1, $2, $3, now() - make_interval(days => $4)) RETURNING id`,
          [player, rank, matchId, daysAgo],
        );
        return row.id;
      };

      await insertObservation(10_000, 10);
      const latest = await insertObservation(15_000, 1);
      await postgres.query(
        "UPDATE players SET premier_rank = 15000 WHERE steam_id = $1",
        [player],
      );

      const premierRank = async () => {
        const [row] = await postgres.query<
          Array<{ premier_rank: number | null }>
        >("SELECT premier_rank FROM players WHERE steam_id = $1", [player]);
        return row.premier_rank === null ? null : Number(row.premier_rank);
      };

      // Dropping the newest observation falls back to the older one.
      await postgres.query(
        "DELETE FROM player_premier_rank_history WHERE id = $1",
        [latest],
      );
      expect(await premierRank()).toBe(10_000);

      // Dropping the last observation clears the rank entirely.
      await postgres.query(
        "DELETE FROM player_premier_rank_history WHERE steam_id = $1",
        [player],
      );
      expect(await premierRank()).toBeNull();
    });
  });
});
