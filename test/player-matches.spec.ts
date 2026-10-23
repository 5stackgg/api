import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// players.matches (get_player_matches) is how the hub's recent games reach a
// player's matches: it must be exactly the matches the player is in a lineup
// of, and finding the latest ten must cost the player's own history, not every
// match on the site.
describe("a player's matches", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let players: Record<string, string>;

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerMatchesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199710000000n);
    await fx.region();
    const [regular, other, idle] = await fx.players(3);
    players = { regular, other, idle };

    for (let i = 0; i < 6; i++) {
      const { matchId } = await fx.bareMatch(new Date().toISOString());
      const { lineup_1_id, lineup_2_id } = await lineups(matchId);
      await fx.lineupPlayer(i % 2 ? lineup_1_id : lineup_2_id, regular);
      await fx.lineupPlayer(i % 2 ? lineup_2_id : lineup_1_id, other);
    }
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function lineups(matchId: string) {
    const [row] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >("SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [matchId]);
    return row;
  }

  const ids = async (sql: string, steamId: string) =>
    (await postgres.query<Array<{ id: string }>>(sql, [steamId]))
      .map((r) => r.id)
      .sort();

  it("is every match the player is in a lineup of, once each", async () => {
    for (const [name, steamId] of Object.entries(players)) {
      const listed = await ids(
        "SELECT m.id FROM players p, LATERAL get_player_matches(p) m WHERE p.steam_id = $1",
        steamId,
      );
      expect({ name, listed }).toEqual({
        name,
        listed: await ids(
          `SELECT DISTINCT m.id FROM match_lineup_players mlp
             JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
             JOIN matches m ON m.id = ml.match_id
            WHERE mlp.steam_id = $1`,
          steamId,
        ),
      });
      expect({ name, listed }).toEqual({
        name,
        listed: await ids(
          `SELECT m.id FROM matches m
            WHERE EXISTS (SELECT 1 FROM match_lineup_players mlp
                           WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                             AND mlp.steam_id = $1)`,
          steamId,
        ),
      });
    }
    expect(
      await ids(
        "SELECT m.id FROM players p, LATERAL get_player_matches(p) m WHERE p.steam_id = $1",
        players.regular,
      ),
    ).toHaveLength(6);
  });

  describe("cost", () => {
    const buffersFor = (steamId: string) =>
      postgres.transaction(async (client) => {
        await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
        const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT m.id FROM players p, LATERAL get_player_matches(p) m
           WHERE p.steam_id = $1 AND m.status = 'Finished'
           ORDER BY m.created_at DESC LIMIT 10`;
        for (let i = 0; i < 6; i++) {
          await client.query(explain, [steamId]);
        }
        const { rows } = await client.query(explain, [steamId]);
        const plan = rows[0]["QUERY PLAN"][0].Plan;
        return plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
      });

    // The recent games panel of a player with few matches used to read
    // matches newest first until it found ten of theirs, which for them meant
    // every match there is.
    it("finds a player's latest matches however many other matches there are", async () => {
      const [newcomer] = await fx.players(1);
      const { matchId } = await fx.bareMatch(new Date().toISOString());
      await fx.lineupPlayer((await lineups(matchId)).lineup_1_id, newcomer);
      await postgres.query(
        "UPDATE matches SET status = 'Finished' WHERE id = $1",
        [matchId],
      );
      const before = await buffersFor(newcomer);

      const others: Array<string> = [];
      for (let i = 0; i < 400; i++) {
        others.push((await fx.bareMatch(new Date().toISOString())).matchId);
      }
      await postgres.transaction(async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          "UPDATE matches SET status = 'Finished' WHERE id = ANY($1::uuid[])",
          [others],
        );
      });
      await postgres.query("VACUUM ANALYZE matches");

      expect((await buffersFor(newcomer)) - before).toBeLessThanOrEqual(5);
    }, 300_000);
  });
});
