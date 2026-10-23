import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// match_maps.lineup_1_rounds_won / lineup_2_rounds_won let lineup_1_score and
// lineup_2_score read a column: they have to answer what the latest-round
// lookups did after any write to a map's rounds.
describe("stored match map scores", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchMapScoresTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199780000000n);
    await fx.region();

    // The lookups as they were.
    for (const side of [1, 2]) {
      await postgres.query(`
        CREATE FUNCTION test_was_lineup_${side}_score(match_map public.match_maps) RETURNS integer
        LANGUAGE plpgsql STABLE AS $$
        DECLARE
            score int;
        BEGIN
            select lineup_${side}_score into score from match_map_rounds mmr
            where mmr.match_map_id = match_map.id
              and mmr.deleted_at is null
            order by time desc
            limit 1;
            IF score IS NULL THEN
                score := 0;
            END IF;
            return score;
        END;
        $$`);
    }
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  let roundNumber = 0;
  async function round(
    mapId: string,
    lineup1: number,
    lineup2: number,
    time: string,
  ): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_map_rounds
         (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
          "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
          lineup_1_side, lineup_2_side, winning_side)
       VALUES ($1, $2, $3, $4, 800, 800, $5, 3, 3, 'CT', 'TERRORIST', 'CT')
       RETURNING id`,
      [mapId, ++roundNumber, lineup1, lineup2, time],
    );
    return row.id;
  }

  async function mismatches(mapIds: string[]) {
    const [row] = await postgres.query<
      Array<{ lineup_1: number; lineup_2: number }>
    >(
      `SELECT
         count(*) FILTER (WHERE lineup_1_score(mm) IS DISTINCT FROM test_was_lineup_1_score(mm))::int AS lineup_1,
         count(*) FILTER (WHERE lineup_2_score(mm) IS DISTINCT FROM test_was_lineup_2_score(mm))::int AS lineup_2
       FROM match_maps mm WHERE id = ANY ($1::uuid[])`,
      [mapIds],
    );
    return row;
  }

  it("answers what the latest-round lookups did, for every map, through random writes", async () => {
    let seed = 20261023;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: T[]): T =>
      items[Math.floor(random() * items.length)];
    const score = () => Math.floor(random() * 16);
    let clock = Date.parse("2026-10-01T12:00:00Z");
    const tick = () =>
      new Date((clock += 1_000 + Math.floor(random() * 90_000))).toISOString();

    const maps: string[] = [];
    for (let index = 0; index < 5; index++) {
      maps.push((await fx.bareMatch()).mapId);
    }
    const rounds: string[] = [];

    for (let index = 0; index < 200; index++) {
      const roll = random();
      let done = "nothing";
      if (roll < 0.45 || rounds.length === 0) {
        rounds.push(await round(pick(maps), score(), score(), tick()));
        done = "round";
      } else if (roll < 0.55) {
        await postgres.query(
          "UPDATE match_map_rounds SET deleted_at = CASE WHEN deleted_at IS NULL THEN now() ELSE NULL END WHERE id = $1",
          [pick(rounds)],
        );
        done = "delete or restore";
      } else if (roll < 0.65) {
        await postgres.query(
          "UPDATE match_map_rounds SET lineup_1_score = $2, lineup_2_score = $3 WHERE id = $1",
          [pick(rounds), score(), score()],
        );
        done = "rescore";
      } else if (roll < 0.72) {
        await postgres.query(
          `UPDATE match_map_rounds SET "time" = $2 WHERE id = $1`,
          [
            pick(rounds),
            new Date(clock - Math.floor(random() * 3_600_000)).toISOString(),
          ],
        );
        done = "retime";
      } else if (roll < 0.8) {
        await postgres.query(
          "UPDATE match_map_rounds SET match_map_id = $2 WHERE id = $1",
          [pick(rounds), pick(maps)],
        );
        done = "move to another map";
      } else if (roll < 0.9) {
        await postgres.query("DELETE FROM match_map_rounds WHERE id = $1", [
          pick(rounds),
        ]);
        done = "hard delete";
      } else {
        const mapId = pick(maps);
        await postgres.query(
          `INSERT INTO match_map_rounds
             (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
              "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
              lineup_1_side, lineup_2_side, winning_side)
           SELECT $1, $2 + n, n, 0, 800, 800, $3::timestamptz + make_interval(secs => n), 3, 3, 'CT', 'TERRORIST', 'CT'
           FROM generate_series(1, 6) AS n`,
          [mapId, roundNumber, tick()],
        );
        roundNumber += 6;
        done = "import";
      }

      expect({ step: index, done, ...(await mismatches(maps)) }).toEqual({
        step: index,
        done,
        lineup_1: 0,
        lineup_2: 0,
      });
    }
  });

  it("is backfilled by its migration from the rounds already there", async () => {
    const { mapId } = await fx.bareMatch();
    await round(mapId, 7, 4, "2026-10-02T12:00:00Z");
    await round(mapId, 8, 4, "2026-10-02T12:01:00Z");
    await postgres.query(
      "UPDATE match_maps SET lineup_1_rounds_won = 0, lineup_2_rounds_won = 0 WHERE id = $1",
      [mapId],
    );

    await postgres.query(
      readFileSync(
        join(
          __dirname,
          "../hasura/migrations/default/1890000001390_match_maps_stored_scores/up.sql",
        ),
        "utf8",
      ),
    );

    const [row] = await postgres.query<Array<{ l1: number; l2: number }>>(
      "SELECT lineup_1_score(mm) AS l1, lineup_2_score(mm) AS l2 FROM match_maps mm WHERE id = $1",
      [mapId],
    );
    expect(row).toEqual({ l1: 8, l2: 4 });
  });

  it("reads the stored columns inline, the way Hasura selects them", async () => {
    const { mapId } = await fx.bareMatch();
    const plan = (
      await postgres.query<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (VERBOSE, COSTS OFF)
         SELECT public.lineup_1_score("_root.base"), public.lineup_2_score("_root.base")
         FROM (SELECT * FROM public.match_maps WHERE id = ANY ($1::uuid[])) AS "_root.base"`,
        [[mapId]],
      )
    )
      .map((line) => line["QUERY PLAN"])
      .join("\n");

    expect(plan).not.toMatch(/lineup_[12]_score\(|match_map_rounds/);
    expect(plan).toContain("lineup_1_rounds_won");
  });
});
