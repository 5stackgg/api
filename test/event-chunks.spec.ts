import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

const EVENT_TABLES = [
  "player_assists",
  "player_damages",
  "player_flashes",
  "player_kills",
  "player_objectives",
  "player_utility",
];

const MIGRATION = join(
  __dirname,
  "../hasura/migrations/default/1890000001320_event_chunks_13_weeks/up.sql",
);

// The match page reads every event table by match or map, never by time, so
// each read probes every chunk's index: the fewer the chunks, the cheaper a
// match page, and weekly chunks add one more every week.
describe("event hypertable chunks", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("EventChunksTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199730000000n);
    await fx.region();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const chunks = async (table: string, from: string, to: string) =>
    postgres.query<Array<{ range_start: Date; range_end: Date }>>(
      `SELECT range_start, range_end FROM timescaledb_information.chunks
        WHERE hypertable_name = $1 AND range_end > $2 AND range_start < $3
        ORDER BY range_start`,
      [table, from, to],
    );

  const weeksFrom = (start: string, week: number) =>
    new Date(Date.parse(start) + week * 7 * 86_400_000 + 86_400_000);

  it("keeps a quarter of each table's events in one chunk", async () => {
    const rows = await postgres.query<
      Array<{ hypertable_name: string; time_interval: { days: number } }>
    >(
      `SELECT hypertable_name, time_interval
         FROM timescaledb_information.dimensions
        WHERE hypertable_name = ANY($1)
        ORDER BY hypertable_name`,
      [EVENT_TABLES],
    );

    expect(rows.map((r) => [r.hypertable_name, r.time_interval.days])).toEqual(
      EVENT_TABLES.map((t) => [t, 91]),
    );
  });

  it("reads a match's kills from a handful of chunks with half a year of others", async () => {
    const [attacker, victim] = await fx.players(2);
    const start = "2021-01-04";
    for (let week = 0; week < 26; week++) {
      const other = await fx.bareMatch();
      await fx.kill(other, attacker, victim, {
        time: weeksFrom(start, week).toISOString(),
      });
    }
    const mine = await fx.bareMatch();
    await fx.kill(mine, attacker, victim, {
      time: weeksFrom(start, 25).toISOString(),
    });
    await postgres.query("ANALYZE player_kills");

    const [{ "QUERY PLAN": plan }] = await postgres.query<
      Array<{ "QUERY PLAN": string }>
    >(
      `EXPLAIN (FORMAT JSON) SELECT * FROM v_match_kill_pairs WHERE match_id = $1`,
      [mine.matchId],
    );
    const scanned =
      JSON.stringify(plan).match(/"Relation Name":"_hyper_\d+_\d+_chunk"/g) ??
      [];

    expect(
      (await chunks("player_kills", start, "2021-07-05")).length,
    ).toBeLessThanOrEqual(3);
    expect(scanned.length).toBeLessThanOrEqual(6);
  });

  // An install that already has weekly chunks: the migration merges each run
  // of adjacent ones into its quarter. A week with no events leaves a gap
  // that can't be merged across, so the runs either side stay apart.
  it("merges an install's existing weekly chunks without losing a row", async () => {
    await postgres.query(
      "SELECT set_chunk_time_interval('player_kills', interval '1 week')",
    );
    const [attacker, victim] = await fx.players(2);
    const start = "2019-01-07";
    const weeks = [0, 1, 2, 3, 6, 7];
    for (const week of weeks) {
      const map = await fx.bareMatch();
      await fx.kill(map, attacker, victim, {
        time: weeksFrom(start, week).toISOString(),
      });
    }
    const before = await chunks("player_kills", start, "2019-03-04");
    expect(before.length).toBe(weeks.length);

    await postgres.query(readFileSync(MIGRATION, "utf8"));

    const after = await chunks("player_kills", start, "2019-03-04");
    expect(after.length).toBeLessThan(before.length);
    expect(after.length).toBeLessThanOrEqual(3);
    const [{ n }] = await postgres.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM player_kills
        WHERE attacker_steam_id = $1 AND time >= $2 AND time < '2019-03-04'`,
      [attacker, start],
    );
    expect(n).toBe(weeks.length);
    const [{ time_interval }] = await postgres.query<
      Array<{ time_interval: { days: number } }>
    >(
      "SELECT time_interval FROM timescaledb_information.dimensions WHERE hypertable_name = 'player_kills'",
    );
    expect(time_interval.days).toBe(91);
  });
});
