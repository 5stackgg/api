import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { TelemetryService } from "./../src/telemetry/telemetry.service";

// TEMPORARY benchmark — not a committed guard.
describe("telemetry perf", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let service: TelemetryService;

  beforeAll(async () => {
    db = await bootMigratedDb("TelemetryPerfTest");
    postgres = db.postgres;

    service = new TelemetryService(
      new Logger("Perf"),
      {
        getConnection: () => ({
          setex: async () => "OK",
          scan: async () => ["0", []],
        }),
      } as never,
      null as never,
      { get: () => ({ webDomain: "https://panel.test" }) } as never,
      postgres,
      { getPanelVersion: async () => "abc" } as never,
      {
        remember: async (_k: string, cb: () => Promise<unknown>) => await cb(),
      } as never,
    );

    await postgres.query(
      `INSERT INTO server_regions (value, is_lan) VALUES ('PerfRegion', false)
       ON CONFLICT (value) DO NOTHING`,
    );
    await postgres.query(
      `INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
       VALUES ('127.0.0.1', 'perf-server', '\\x00'::bytea, 27915, true, 'PerfRegion', 'Ranked', true)`,
    );

    const MATCHES = 20000;

    console.log(`seeding ${MATCHES} matches...`);
    const started = Date.now();

    await postgres.query(
      `INSERT INTO match_lineups (id)
       SELECT gen_random_uuid() FROM generate_series(1, ${MATCHES * 2})`,
    );

    await postgres.query(
      `WITH numbered AS (
         SELECT id, row_number() OVER () AS rn FROM match_lineups
       ),
       pairs AS (
         SELECT a.id AS l1, b.id AS l2, a.rn
         FROM numbered a
         JOIN numbered b ON b.rn = a.rn + ${MATCHES}
         WHERE a.rn <= ${MATCHES}
       )
       INSERT INTO matches (lineup_1_id, lineup_2_id, source, started_at, ended_at, created_at)
       SELECT l1, l2,
              CASE WHEN rn % 5 = 0 THEN 'faceit' ELSE '5stack' END,
              now() - (rn || ' hours')::interval,
              now() - (rn || ' hours')::interval,
              now() - (rn || ' hours')::interval
       FROM pairs`,
    );

    await postgres.query(
      `INSERT INTO players (steam_id, name)
       SELECT 76561190000000000 + g, 'p' || g FROM generate_series(1, 5000) g`,
    );

    // 10 players per match — the table the active-player join has to walk.
    await postgres.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
       SELECT l.id, 76561190000000000 + ((row_number() OVER ()) % 5000) + 1
       FROM match_lineups l, generate_series(1, 5) s`,
    );

    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order", status)
       SELECT m.id, (SELECT id FROM maps ORDER BY name LIMIT 1), 1, 'Finished'
       FROM matches m`,
    );

    console.log(`seeded in ${Date.now() - started}ms`);

    const counts = await postgres.query<Array<Record<string, string>>>(
      `SELECT
         (SELECT count(*) FROM matches) AS matches,
         (SELECT count(*) FROM match_lineup_players) AS lineup_players,
         (SELECT count(*) FROM match_maps) AS maps`,
    );
    console.log("row counts:", counts[0]);

    await postgres.query("ANALYZE");
  }, 900_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("times the whole collect()", async () => {
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      await service.collect();
      console.log(`collect() run ${i + 1}: ${Date.now() - started}ms`);
    }
  }, 300_000);

  it("times the active-player join on its own", async () => {
    const sql = `SELECT count(DISTINCT p.steam_id)
       FROM public.match_lineup_players p
       JOIN public.matches m
         ON m.lineup_1_id = p.match_lineup_id OR m.lineup_2_id = p.match_lineup_id
      WHERE p.steam_id IS NOT NULL
        AND m.started_at IS NOT NULL
        AND m.effective_at >= now() - interval '30 days'`;

    const started = Date.now();
    await postgres.query(sql);
    console.log(`OR-join active players: ${Date.now() - started}ms`);

    const plan = await postgres.query<Array<Record<string, string>>>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    );
    console.log(plan.map((r) => r["QUERY PLAN"]).join("\n"));
  }, 300_000);

  it("times an IN-rewrite of the same thing", async () => {
    const sql = `SELECT count(DISTINCT p.steam_id)
       FROM public.match_lineup_players p
      WHERE p.steam_id IS NOT NULL
        AND p.match_lineup_id IN (
          SELECT lineup_1_id FROM public.matches
           WHERE started_at IS NOT NULL AND effective_at >= now() - interval '30 days'
          UNION
          SELECT lineup_2_id FROM public.matches
           WHERE started_at IS NOT NULL AND effective_at >= now() - interval '30 days'
        )`;

    const started = Date.now();
    await postgres.query(sql);
    console.log(`IN-rewrite active players: ${Date.now() - started}ms`);

    const plan = await postgres.query<Array<Record<string, string>>>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    );
    console.log(plan.map((r) => r["QUERY PLAN"]).join("\n"));
  }, 300_000);
});
