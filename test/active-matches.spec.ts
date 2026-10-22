import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// active_matches() roots the site's live and upcoming subscriptions. Each one
// still filters by status itself, so it must hand back exactly the rows that
// filter picks from matches, and its reads must not grow with finished history.
describe("active_matches", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let statuses: Array<string>;

  const ACTIVE = [
    "Live",
    "Veto",
    "WaitingForCheckIn",
    "WaitingForServer",
    "Scheduled",
    "PickingPlayers",
  ];

  // The status sets the web filters on: live ticker and counts, upcoming,
  // my matches as a player, and my matches or managed ones as an organizer.
  const FILTERS = [
    ["Live", "WaitingForServer", "Veto", "WaitingForCheckIn"],
    ["Scheduled"],
    ["Live", "Veto", "WaitingForCheckIn", "WaitingForServer", "Scheduled"],
    ACTIVE,
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("ActiveMatchesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199770000000n);
    await fx.region();
    statuses = (
      await postgres.query<Array<{ value: string }>>(
        "SELECT value FROM e_match_status ORDER BY value",
      )
    ).map((r) => r.value);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  // Only the status matters here, not the transitions that lead to it.
  const setStatus = (ids: Array<string>, status: string) =>
    postgres.transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE matches SET status = $2 WHERE id = ANY($1::uuid[])",
        [ids, status],
      );
    });

  const ids = async (from: string, filter: Array<string>) =>
    (
      await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM ${from} WHERE status = ANY($1::text[]) ORDER BY id`,
        [filter],
      )
    ).map((r) => r.id);

  it("hands each subscription the rows its status filter picks from matches", async () => {
    for (const status of statuses) {
      for (let i = 0; i < 2; i++) {
        const { matchId } = await fx.bareMatch();
        await setStatus([matchId], status);
      }
    }

    for (const filter of [...FILTERS, ...statuses.map((s) => [s])]) {
      expect({ filter, rows: await ids("active_matches()", filter) }).toEqual({
        filter,
        rows: await ids(
          "matches",
          filter.filter((s) => ACTIVE.includes(s)),
        ),
      });
    }
  });

  describe("cost", () => {
    // How a subscription sends its status filter: a value Postgres only sees
    // at run time, on the cached generic plan Hasura's statements settle on.
    const buffersFor = (from: string, filter: Array<string>) =>
      postgres.transaction(async (client) => {
        await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
        const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT count(*) FROM ${from} m
           WHERE m.status = ANY(($1::json #>> '{statuses}')::text[])`;
        const vars = JSON.stringify({ statuses: `{${filter.join(",")}}` });
        for (let i = 0; i < 6; i++) {
          await client.query(explain, [vars]);
        }
        const { rows } = await client.query(explain, [vars]);
        const plan = rows[0]["QUERY PLAN"][0].Plan;
        return plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
      });

    it("does not grow with finished matches", async () => {
      const before = await Promise.all(
        FILTERS.map((f) => buffersFor("active_matches()", f)),
      );

      const finished: Array<string> = [];
      for (let i = 0; i < 400; i++) {
        finished.push((await fx.bareMatch(new Date().toISOString())).matchId);
      }
      await setStatus(finished, "Finished");
      await postgres.query("VACUUM ANALYZE matches");

      const after = await Promise.all(
        FILTERS.map((f) => buffersFor("active_matches()", f)),
      );
      const growth = FILTERS.map((filter, i) => ({
        filter,
        buffers: after[i] - before[i],
      }));
      expect(growth.filter(({ buffers }) => buffers > 5)).toEqual([]);
    }, 120_000);
  });
});
