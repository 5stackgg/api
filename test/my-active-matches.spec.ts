import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// my_active_matches() roots every signed-in player's "my matches"
// subscription and the watch page's own-match flags, so it must hand back
// exactly the active matches that player is in a lineup of, coaches or
// organizes, and a poll must cost the player's own matches,
// not every active match on the site.
describe("my_active_matches", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let statuses: Array<string>;
  let players: Record<string, string>;

  beforeAll(async () => {
    db = await bootMigratedDb("MyActiveMatchesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199720000000n);
    await fx.region();
    statuses = (
      await postgres.query<Array<{ value: string }>>(
        "SELECT value FROM e_match_status ORDER BY value",
      )
    ).map((r) => r.value);
    const [first, second, organizer, both, coach, idle, stranger] =
      await fx.players(7);
    players = { first, second, organizer, both, coach, idle, stranger };
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const session = (steamId: string) =>
    JSON.stringify({ "x-hasura-role": "user", "x-hasura-user-id": steamId });

  // Only the status matters here, not the transitions that lead to it.
  const setStatus = (ids: Array<string>, status: string) =>
    postgres.transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE matches SET status = $2 WHERE id = ANY($1::uuid[])",
        [ids, status],
      );
    });

  const lineups = async (matchId: string) =>
    (
      await postgres.query<Array<{ lineup_1_id: string; lineup_2_id: string }>>(
        "SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1",
        [matchId],
      )
    )[0];

  const seat = (lineupId: string, steamId: string) =>
    postgres.query(
      "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
      [lineupId, steamId],
    );

  async function mine(steamId: string) {
    return (
      await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM my_active_matches($1::json) ORDER BY id",
        [session(steamId)],
      )
    ).map((r) => r.id);
  }

  // Every active match, kept where the player is in a lineup, coaches or
  // organizes it.
  async function before(steamId: string) {
    return (
      await postgres.query<Array<{ id: string }>>(
        `SELECT m.id FROM active_matches() m
          WHERE is_in_lineup(m, $1::json) OR is_coach(m, $1::json)
             OR m.organizer_steam_id = $2
          ORDER BY m.id`,
        [session(steamId), steamId],
      )
    ).map((r) => r.id);
  }

  it("hands each player the active matches they play in, coach or organize", async () => {
    const { first, second, organizer, both, coach } = players;
    for (const status of statuses) {
      for (let i = 0; i < 2; i++) {
        const { matchId } = await fx.bareMatch();
        const { lineup_1_id, lineup_2_id } = await lineups(matchId);
        await seat(lineup_1_id, i ? first : both);
        await seat(lineup_2_id, i ? second : first);
        await postgres.query(
          "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
          [matchId, i ? organizer : both],
        );
        await postgres.query(
          "UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1",
          [i ? lineup_2_id : lineup_1_id, coach],
        );
        await setStatus([matchId], status);
      }
    }

    for (const [name, steamId] of Object.entries(players)) {
      expect({ name, rows: await mine(steamId) }).toEqual({
        name,
        rows: await before(steamId),
      });
    }
    expect((await mine(first)).length).toBeGreaterThan(0);
    expect((await mine(organizer)).length).toBeGreaterThan(0);
    expect((await mine(coach)).length).toBeGreaterThan(0);
  });

  describe("cost", () => {
    // How a subscription sends the session: a value Postgres only sees at run
    // time, on the cached generic plan Hasura's statements settle on.
    const buffersFor = (steamId: string) =>
      postgres.transaction(async (client) => {
        await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
        const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT id FROM my_active_matches($1::json)`;
        for (let i = 0; i < 6; i++) {
          await client.query(explain, [session(steamId)]);
        }
        const { rows } = await client.query(explain, [session(steamId)]);
        const plan = rows[0]["QUERY PLAN"][0].Plan;
        return plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
      });

    it("does not grow with other players' active matches", async () => {
      const { idle, stranger } = players;
      const before = await buffersFor(idle);

      const busy: Array<string> = [];
      for (let i = 0; i < 300; i++) {
        const { matchId } = await fx.bareMatch();
        const { lineup_1_id, lineup_2_id } = await lineups(matchId);
        await seat(lineup_1_id, stranger);
        await seat(lineup_2_id, (await fx.players(1))[0]);
        busy.push(matchId);
      }
      await setStatus(busy, "Live");
      await postgres.query("VACUUM ANALYZE matches");

      expect((await buffersFor(idle)) - before).toBeLessThanOrEqual(5);
    }, 300_000);
  });
});
