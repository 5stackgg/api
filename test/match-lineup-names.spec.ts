import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// match_lineups.display_name lets get_team_name read a column: it has to
// answer what the lookups did after a write to any table the name comes from.
describe("stored match lineup names", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let tournamentId: string;
  let stageId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchLineupNamesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199790000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await fx.region();
    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 64 },
    ]);
    tournamentId = tournament.id;
    stageId = tournament.stageIds[0];

    // get_team_name as it was.
    await postgres.query(`
      CREATE FUNCTION test_was_team_name(match_lineup public.match_lineups) RETURNS text
      LANGUAGE plpgsql STABLE AS $$
      DECLARE
          _team_name TEXT;
          _lineup_1_id uuid;
          _lineup_2_id uuid;
      BEGIN
          SELECT m.lineup_1_id, m.lineup_2_id, COALESCE(ml.team_name, t.name)
          INTO _lineup_1_id, _lineup_2_id, _team_name
          FROM matches m
          JOIN match_lineups ml ON ml.match_id = m.id
          LEFT JOIN teams t ON t.id = ml.team_id
          WHERE ml.id = match_lineup.id;

          IF _team_name IS NOT NULL THEN
              RETURN _team_name;
          END IF;

          SELECT COALESCE(tt.name, t2.name)
          INTO _team_name
          FROM matches m
          JOIN tournament_brackets tb ON tb.match_id = m.id
          JOIN tournament_teams tt ON
              (match_lineup.id = m.lineup_1_id AND tt.id = tb.tournament_team_id_1)
              OR
              (match_lineup.id = m.lineup_2_id AND tt.id = tb.tournament_team_id_2)
          LEFT JOIN teams t2 ON t2.id = tt.team_id
          WHERE m.id = (SELECT match_id FROM match_lineups WHERE id = match_lineup.id)
          LIMIT 1;

          IF _team_name IS NOT NULL THEN
              RETURN _team_name;
          END IF;

          IF match_lineup.id = _lineup_1_id THEN
              RETURN 'Team 1';
          ELSE
              RETURN 'Team 2';
          END IF;
      END;
      $$`);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function mismatches(matchIds: string[]) {
    const rows = await postgres.query<
      Array<{ id: string; now: string; was: string }>
    >(
      `SELECT ml.id, get_team_name(ml) AS now, test_was_team_name(ml) AS was
       FROM match_lineups ml
       WHERE ml.match_id = ANY ($1::uuid[])
          OR ml.id IN (SELECT unnest(ARRAY[m.lineup_1_id, m.lineup_2_id]) FROM matches m WHERE m.id = ANY ($1::uuid[]))`,
      [matchIds],
    );
    return rows.filter((row) => row.now !== row.was);
  }

  it("answers what the lookups did, for every lineup, through random writes", async () => {
    let seed = 20261023;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: T[]): T =>
      items[Math.floor(random() * items.length)];
    let n = 0;
    const name = () => `name ${++n}`;

    const teams: Array<{ id: string; owner: string }> = [];
    for (let i = 0; i < 4; i++) teams.push(await fx.team());
    const tournamentTeams: string[] = [];
    for (const team of teams) {
      tournamentTeams.push(await tfx.registerTeam(tournamentId, team));
    }
    const [adHoc] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO tournament_teams (tournament_id, name, owner_steam_id) VALUES ($1, 'Walk-ins', $2) RETURNING id",
      [tournamentId, await fx.player()],
    );
    tournamentTeams.push(adHoc.id);

    const matches: string[] = [];
    for (let i = 0; i < 6; i++) matches.push((await fx.bareMatch()).matchId);
    const lineups = async () =>
      (
        await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM match_lineups WHERE match_id = ANY ($1::uuid[])",
          [matches],
        )
      ).map((row) => row.id);
    let matchNumber = 0;
    const tally: Record<string, number> = {};

    for (let index = 0; index < 160; index++) {
      const roll = random();
      let done = "nothing";
      try {
        if (roll < 0.14) {
          await postgres.query(
            "UPDATE match_lineups SET team_name = $2 WHERE id = $1",
            [pick(await lineups()), random() < 0.5 ? name() : null],
          );
          done = "lineup team name";
        } else if (roll < 0.26) {
          await postgres.query(
            "UPDATE match_lineups SET team_id = $2 WHERE id = $1",
            [pick(await lineups()), random() < 0.6 ? pick(teams).id : null],
          );
          done = "lineup team";
        } else if (roll < 0.36) {
          await postgres.query("UPDATE teams SET name = $2 WHERE id = $1", [
            pick(teams).id,
            name(),
          ]);
          done = "rename team";
        } else if (roll < 0.46) {
          await postgres.query(
            "UPDATE tournament_teams SET name = $2 WHERE id = $1",
            [pick(tournamentTeams), random() < 0.8 ? name() : null],
          );
          done = "rename tournament team";
        } else if (roll < 0.52) {
          await postgres.query(
            "UPDATE tournament_teams SET team_id = $2 WHERE id = $1",
            [pick(tournamentTeams), random() < 0.5 ? pick(teams).id : null],
          );
          done = "tournament team's team";
        } else if (roll < 0.66) {
          await postgres.query(
            `INSERT INTO tournament_brackets
               (tournament_stage_id, round, match_number, match_id, tournament_team_id_1, tournament_team_id_2)
             VALUES ($1, 1, $2, $3, $4, $5)`,
            [
              stageId,
              ++matchNumber,
              pick(matches),
              random() < 0.8 ? pick(tournamentTeams) : null,
              random() < 0.8 ? pick(tournamentTeams) : null,
            ],
          );
          done = "bracket";
        } else if (roll < 0.8) {
          await postgres.query(
            `UPDATE tournament_brackets SET tournament_team_id_1 = $2, tournament_team_id_2 = $3
             WHERE id = (SELECT id FROM tournament_brackets WHERE match_id = ANY ($1::uuid[]) ORDER BY random() LIMIT 1)`,
            [
              matches,
              random() < 0.8 ? pick(tournamentTeams) : null,
              random() < 0.8 ? pick(tournamentTeams) : null,
            ],
          );
          done = "bracket teams";
        } else if (roll < 0.86) {
          await postgres.query(
            `UPDATE tournament_brackets SET match_id = $2
             WHERE id = (SELECT id FROM tournament_brackets WHERE match_id = ANY ($1::uuid[]) ORDER BY random() LIMIT 1)`,
            [matches, pick(matches)],
          );
          done = "bracket match";
        } else if (roll < 0.9) {
          matches.push((await fx.bareMatch()).matchId);
          done = "match";
        } else if (roll < 0.95) {
          const team = pick(teams);
          await postgres.query("DELETE FROM teams WHERE id = $1", [team.id]);
          teams.splice(teams.indexOf(team), 1, await fx.team());
          tournamentTeams.splice(
            0,
            tournamentTeams.length,
            ...(
              await postgres.query<Array<{ id: string }>>(
                "SELECT id FROM tournament_teams WHERE tournament_id = $1",
                [tournamentId],
              )
            ).map((row) => row.id),
          );
          done = "delete team";
        } else {
          await postgres.query(
            `UPDATE matches SET lineup_1_id = lineup_2_id, lineup_2_id = lineup_1_id WHERE id = $1`,
            [pick(matches)],
          );
          done = "swap lineups";
        }
      } catch (error) {
        done = `skipped: ${(error as Error).message.slice(0, 80)}`;
      }

      const kind = done.startsWith("skipped") ? "skipped" : done;
      tally[kind] = (tally[kind] ?? 0) + 1;

      expect({
        step: index,
        done,
        mismatches: await mismatches(matches),
      }).toEqual({
        step: index,
        done,
        mismatches: [],
      });
    }

    // Every kind of write ran, and few were refused.
    expect(
      Object.keys(tally).filter((kind) => kind !== "skipped"),
    ).toHaveLength(11);
    expect(tally.skipped ?? 0).toBeLessThan(16);
  });

  it("is backfilled by its migration from get_team_name", async () => {
    const team = await fx.team();
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      `UPDATE match_lineups SET team_id = $2
       WHERE id = (SELECT lineup_1_id FROM matches WHERE id = $1)`,
      [matchId, team.id],
    );
    await postgres.query(
      "UPDATE match_lineups SET display_name = NULL WHERE match_id = $1",
      [matchId],
    );

    await postgres.query(
      `UPDATE match_lineups ml SET display_name = public.get_team_name(ml) WHERE match_id = $1`,
      [matchId],
    );

    const rows = await postgres.query<Array<{ stored: string | null }>>(
      "SELECT display_name AS stored FROM match_lineups WHERE match_id = $1",
      [matchId],
    );
    expect(rows.every((row) => row.stored !== null)).toBe(true);
    expect(await mismatches([matchId])).toEqual([]);
  });

  it("reads the stored name inline, the way Hasura selects it", async () => {
    const { matchId } = await fx.bareMatch();
    const plan = (
      await postgres.query<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (VERBOSE, COSTS OFF)
         SELECT public.get_team_name("_root.base")
         FROM (SELECT * FROM public.match_lineups WHERE match_id = $1) AS "_root.base"`,
        [matchId],
      )
    )
      .map((line) => line["QUERY PLAN"])
      .join("\n");

    expect(plan).not.toContain("get_team_name");
    expect(plan).toContain("display_name");
  });
});
