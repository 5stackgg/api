import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Organizers edit upcoming tournament matches, one at a time or for a whole
// stage. Where a match is played and how it is broadcast can change; the rules
// it is played under cannot, for any role, once its stage has a match.
describe("tournament match rules once a stage has matches (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  type Tournament = { id: string; organizer: string; stageIds: Array<string> };

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
  ];
  const TWO_STAGES = [
    { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 },
    { type: "SingleElimination", order: 2, minTeams: 2, maxTeams: 2 },
  ];

  const LOCKED = /Match rules are locked once a tournament stage has matches/;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentMatchRulesLockTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199870000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27017);
    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('TestLan', 'TestLan', true) ON CONFLICT (value) DO NOTHING`,
    );
    await postgres.query(
      `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled)
       VALUES ('127.0.0.1', 'TestLan', $1, 27016, 'TestLan', 'Ranked', true, true)`,
      [Buffer.from("password")],
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const asAdministrator = (sql: string, params: Array<unknown>) =>
    runAsUser(postgres, fx.nextSteam(), "administrator", (query) =>
      query(sql, params),
    );

  const update = (optionsId: string, set: string) =>
    asAdministrator(`UPDATE match_options SET ${set} WHERE id = $1`, [
      optionsId,
    ]);

  const tournamentOptionsId = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      "SELECT match_options_id AS id FROM tournaments WHERE id = $1",
      [tournamentId],
    );
    return row.id;
  };

  const giveStageOwnOptions = async (stageId: string, tournamentId: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `UPDATE tournament_stages
       SET match_options_id = clone_match_options(
         (SELECT match_options_id FROM tournaments WHERE id = $1)
       )
       WHERE id = $2
       RETURNING match_options_id AS id`,
      [tournamentId, stageId],
    );
    return row.id;
  };

  const closeRegistration = async (tournament: Tournament) => {
    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
  };

  const stageMatches = (stageId: string) =>
    postgres.query<
      Array<{
        match_options_id: string;
        mr: number;
        best_of: number;
        tv_delay: number;
        region: string | null;
        map_pool_id: string;
      }>
    >(
      `SELECT m.match_options_id, mo.mr, mo.best_of, mo.tv_delay, m.region, mo.map_pool_id
       FROM tournament_brackets tb
       INNER JOIN matches m ON m.id = tb.match_id
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       WHERE tb.tournament_stage_id = $1
       ORDER BY tb.round, tb.match_number`,
      [stageId],
    );

  const optionsRow = async (optionsId: string) => {
    const [row] = await postgres.query<
      Array<{ mr: number; tv_delay: number; map_pool_id: string }>
    >("SELECT mr, tv_delay, map_pool_id FROM match_options WHERE id = $1", [
      optionsId,
    ]);
    return row;
  };

  describe("a single tournament match", () => {
    it("refuses other rules than its stage, even from an administrator", async () => {
      const tournament = await tfx.createTournament(SE4);
      await closeRegistration(tournament);
      const [match] = await stageMatches(tournament.stageIds[0]);

      for (const set of [
        "type = 'Competitive'",
        "mr = 12",
        "best_of = 3",
        "overtime = NOT overtime",
        "coaches = NOT coaches",
        "tech_timeout_setting = 'Admin'",
        "game_mode_id = gen_random_uuid()",
        "knife_round = NOT knife_round",
        "map_veto = NOT map_veto",
        "timeout_setting = 'Admin'",
        "number_of_substitutes = 3",
        "default_models = NOT default_models",
        "halftime_pausematch = NOT halftime_pausematch",
        "round_restart_delay = 1",
      ]) {
        await expect(update(match.match_options_id, set)).rejects.toThrow(
          LOCKED,
        );
      }
      expect((await optionsRow(match.match_options_id)).mr).toBe(8);
    });

    it("moves to another region and broadcast delay", async () => {
      const tournament = await tfx.createTournament(SE4);
      await closeRegistration(tournament);
      const [match] = await stageMatches(tournament.stageIds[0]);

      await update(
        match.match_options_id,
        "regions = '{TestLan}', region_veto = false, tv_delay = 45, check_in_setting = 'Admin'",
      );

      const [moved] = await stageMatches(tournament.stageIds[0]);
      expect(moved.region).toBe("TestLan");
      expect(moved.tv_delay).toBe(45);
    });

    it("refuses another map pool but takes a fresh copy of the same maps", async () => {
      const tournament = await tfx.createTournament(SE4);
      await closeRegistration(tournament);
      const [match] = await stageMatches(tournament.stageIds[0]);

      const [copy] = await postgres.query<Array<{ id: string }>>(
        `WITH pool AS (INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id)
         INSERT INTO _map_pool (map_pool_id, map_id)
         SELECT pool.id, mp.map_id FROM pool, _map_pool mp WHERE mp.map_pool_id = $1
         RETURNING map_pool_id AS id`,
        [match.map_pool_id],
      );
      await update(match.match_options_id, `map_pool_id = '${copy.id}'`);
      expect((await optionsRow(match.match_options_id)).map_pool_id).toBe(
        match.map_pool_id,
      );

      const smaller = await fx.mapPool(3, { mapType: "Wingman" });
      await expect(
        update(match.match_options_id, `map_pool_id = '${smaller.poolId}'`),
      ).rejects.toThrow(LOCKED);
    });
  });

  it("names only columns match_options has", async () => {
    const missing = await postgres.query<Array<{ col: string }>>(
      `SELECT col FROM unnest(match_options_rule_columns()) AS rule(col)
       EXCEPT
       SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'match_options'`,
    );

    expect(missing).toEqual([]);
  });

  describe("a round's best-of", () => {
    it("reaches the round's matches that have not started, and no match takes another", async () => {
      const tournament = await tfx.createTournament(SE4);
      await closeRegistration(tournament);
      await tfx.setStatus(tournament.id, tournament.organizer, "Live");
      const [vetoing] = await postgres.query<Array<{ id: string }>>(
        `SELECT tb.match_id AS id FROM tournament_brackets tb
         WHERE tb.tournament_stage_id = $1 AND tb.round = 1
         ORDER BY tb.match_number LIMIT 1`,
        [tournament.stageIds[0]],
      );
      await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
        vetoing.id,
      ]);

      await postgres.query(
        `UPDATE tournament_stages SET settings = '{"round_best_of": {"WB:1": 3}}'
         WHERE id = $1`,
        [tournament.stageIds[0]],
      );

      const matches = await stageMatches(tournament.stageIds[0]);
      expect(matches.map((match) => match.best_of)).toEqual([1, 3]);
      await expect(
        update(matches[1].match_options_id, "best_of = 5"),
      ).rejects.toThrow(LOCKED);
    });

    it("stays editable on a stage's own settings after the draw", async () => {
      const tournament = await tfx.createTournament(SE4);
      const stageOptionsId = await giveStageOwnOptions(
        tournament.stageIds[0],
        tournament.id,
      );
      await closeRegistration(tournament);

      await update(stageOptionsId, "best_of = 3");

      const [row] = await postgres.query<Array<{ best_of: number }>>(
        "SELECT best_of FROM match_options WHERE id = $1",
        [stageOptionsId],
      );
      expect(row.best_of).toBe(3);
    });
  });

  describe("a bracket's own settings", () => {
    const attachOwnOptions = (bracketId: string, tournamentId: string) =>
      postgres.query<Array<{ id: string }>>(
        `UPDATE tournament_brackets
         SET match_options_id = clone_match_options(
           (SELECT match_options_id FROM tournaments WHERE id = $2)
         )
         WHERE id = $1
         RETURNING match_options_id AS id`,
        [bracketId, tournamentId],
      );

    it("lock once its pairing is known, before any match of its stage exists", async () => {
      const tournament = await tfx.createTournament(TWO_STAGES);
      await closeRegistration(tournament);
      const [final] = await tfx.getBrackets(tournament.stageIds[1]);
      const [own] = await attachOwnOptions(final.id, tournament.id);

      await update(own.id, "mr = 12");

      const [team] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1 LIMIT 1",
        [tournament.id],
      );
      await postgres.query(
        "UPDATE tournament_brackets SET tournament_team_id_1 = $2 WHERE id = $1",
        [final.id, team.id],
      );

      await expect(update(own.id, "mr = 8")).rejects.toThrow(LOCKED);
      await update(own.id, "tv_delay = 30");
      await expect(
        postgres.query(
          "UPDATE tournament_brackets SET match_options_id = NULL WHERE id = $1",
          [final.id],
        ),
      ).rejects.toThrow(/whose teams are known/);
    });

    it("can't be given to a pairing the draw made public", async () => {
      const tournament = await tfx.createTournament(SE4);
      await update(
        await tournamentOptionsId(tournament.id),
        "match_mode = 'admin'",
      );
      await closeRegistration(tournament);
      const [first] = await tfx.getBrackets(tournament.stageIds[0]);
      expect(first.match_id).toBeNull();

      await expect(attachOwnOptions(first.id, tournament.id)).rejects.toThrow(
        /whose teams are known/,
      );
    });

    const cloneAs = async (steamId: string, bracketId: string) =>
      (await runAsUser(postgres, steamId, "user", (query) =>
        query(
          `SELECT match_options_id
           FROM clone_tournament_bracket_options($1, $2::json)`,
          [
            bracketId,
            JSON.stringify({
              "x-hasura-role": "user",
              "x-hasura-user-id": steamId,
            }),
          ],
        ),
      )) as Array<{ match_options_id: string }>;

    const finalOf = async (stageId: string) =>
      (await tfx.getBrackets(stageId)).find((bracket) => bracket.round === 2)!;

    it("go to an empty bracket of a started stage, and its match is hosted by them under the stage's rules", async () => {
      const tournament = await tfx.createTournament(SE4);
      await closeRegistration(tournament);
      await tfx.setStatus(tournament.id, tournament.organizer, "Live");
      const final = await finalOf(tournament.stageIds[0]);
      const [own] = await cloneAs(tournament.organizer, final.id);

      await update(
        own.match_options_id,
        "regions = '{TestLan}', region_veto = false, ready_setting = 'Admin', tv_delay = 45",
      );
      await expect(update(own.match_options_id, "mr = 12")).rejects.toThrow(
        LOCKED,
      );
      await postgres.query(
        `UPDATE tournament_stages SET settings = '{"round_best_of": {"WB:2": 3}}'
         WHERE id = $1`,
        [tournament.stageIds[0]],
      );

      await tfx.playRound(tournament.stageIds[0], 1);

      const [match] = await postgres.query<
        Array<{
          region: string;
          ready_setting: string;
          tv_delay: number;
          mr: number;
          best_of: number;
        }>
      >(
        `SELECT m.region, mo.ready_setting, mo.tv_delay, mo.mr, mo.best_of
         FROM tournament_brackets tb
         INNER JOIN matches m ON m.id = tb.match_id
         INNER JOIN match_options mo ON mo.id = m.match_options_id
         WHERE tb.id = $1`,
        [final.id],
      );
      expect(match).toEqual({
        region: "TestLan",
        ready_setting: "Admin",
        tv_delay: 45,
        mr: 8,
        best_of: 3,
      });
    });

    it("can't bring other rules into a started stage, and give way to the stage's again", async () => {
      const tournament = await tfx.createTournament(SE4);
      await closeRegistration(tournament);
      const [first] = await tfx.getBrackets(tournament.stageIds[0]);
      const final = await finalOf(tournament.stageIds[0]);

      const [other] = await postgres.query<Array<{ id: string }>>(
        `SELECT clone_match_options(match_options_id) AS id
         FROM tournaments WHERE id = $1`,
        [tournament.id],
      );
      await update(other.id, "mr = 12");
      await expect(
        postgres.query(
          "UPDATE tournament_brackets SET match_options_id = $2 WHERE id = $1",
          [final.id, other.id],
        ),
      ).rejects.toThrow(LOCKED);
      await expect(cloneAs(tournament.organizer, first.id)).rejects.toThrow(
        /whose teams are known/,
      );

      const [own] = await cloneAs(tournament.organizer, final.id);
      await postgres.query(
        "UPDATE tournament_brackets SET match_options_id = NULL WHERE id = $1",
        [final.id],
      );

      expect(
        await postgres.query("SELECT id FROM match_options WHERE id = $1", [
          own.match_options_id,
        ]),
      ).toEqual([]);
    });

    it("follow their stage's later settings while they still hold the stage's value", async () => {
      const tournament = await tfx.createTournament(SE4);
      const stageOptionsId = await giveStageOwnOptions(
        tournament.stageIds[0],
        tournament.id,
      );
      await closeRegistration(tournament);
      const [own] = await cloneAs(
        tournament.organizer,
        (await finalOf(tournament.stageIds[0])).id,
      );
      await update(own.match_options_id, "tv_delay = 45");

      await update(stageOptionsId, "tv_delay = 60, ready_setting = 'Captains'");

      const [row] = await postgres.query<
        Array<{ tv_delay: number; ready_setting: string }>
      >("SELECT tv_delay, ready_setting FROM match_options WHERE id = $1", [
        own.match_options_id,
      ]);
      expect(row).toEqual({ tv_delay: 45, ready_setting: "Captains" });
    });

    it("are only given by the tournament's organizers", async () => {
      const tournament = await tfx.createTournament(SE4);
      const final = await finalOf(tournament.stageIds[0]);

      await expect(cloneAs(await fx.player(), final.id)).rejects.toThrow(
        /Must be an organizer/,
      );
    });
  });

  describe("a stage's own settings", () => {
    it("reach its upcoming matches, but its rules stay put", async () => {
      const tournament = await tfx.createTournament(SE4);
      const stageOptionsId = await giveStageOwnOptions(
        tournament.stageIds[0],
        tournament.id,
      );
      await closeRegistration(tournament);

      await update(stageOptionsId, "tv_delay = 60");
      await expect(update(stageOptionsId, "mr = 12")).rejects.toThrow(LOCKED);

      const matches = await stageMatches(tournament.stageIds[0]);
      expect(matches.length).toBe(2);
      for (const match of matches) {
        expect(match.tv_delay).toBe(60);
        expect(match.mr).toBe(8);
      }
    });
  });

  describe("the tournament's settings", () => {
    it("take new rules until the bracket is drawn", async () => {
      const tournament = await tfx.createTournament(SE4);
      await update(await tournamentOptionsId(tournament.id), "mr = 12");
      await closeRegistration(tournament);

      for (const match of await stageMatches(tournament.stageIds[0])) {
        expect(match.mr).toBe(12);
      }
    });

    it("lock their rules once a stage playing them has matches, and still move those matches", async () => {
      const tournament = await tfx.createTournament(SE4);
      await closeRegistration(tournament);
      const optionsId = await tournamentOptionsId(tournament.id);

      await expect(update(optionsId, "mr = 12")).rejects.toThrow(LOCKED);
      await update(optionsId, "regions = '{TestLan}', region_veto = false");

      for (const match of await stageMatches(tournament.stageIds[0])) {
        expect(match.region).toBe("TestLan");
        expect(match.mr).toBe(8);
      }
    });

    it("carry new rules into a not-started stage's own settings, and not into a started one's", async () => {
      const tournament = await tfx.createTournament(TWO_STAGES);
      const startedOptionsId = await giveStageOwnOptions(
        tournament.stageIds[0],
        tournament.id,
      );
      const waitingOptionsId = await giveStageOwnOptions(
        tournament.stageIds[1],
        tournament.id,
      );
      await closeRegistration(tournament);

      await update(await tournamentOptionsId(tournament.id), "mr = 12");

      expect(await optionsRow(waitingOptionsId)).toMatchObject({ mr: 12 });
      expect(await optionsRow(startedOptionsId)).toMatchObject({ mr: 8 });
    });

    it("give a stage that has not started new rules without touching one that has", async () => {
      const tournament = await tfx.createTournament(TWO_STAGES);
      const startedOptionsId = await giveStageOwnOptions(
        tournament.stageIds[0],
        tournament.id,
      );
      await closeRegistration(tournament);
      expect(
        (await stageMatches(tournament.stageIds[0])).length,
      ).toBeGreaterThan(0);

      const optionsId = await tournamentOptionsId(tournament.id);
      await update(optionsId, "mr = 12, tv_delay = 30");

      expect(await optionsRow(optionsId)).toMatchObject({ mr: 12 });
      expect(await optionsRow(startedOptionsId)).toMatchObject({
        mr: 8,
        tv_delay: 30,
      });
      for (const match of await stageMatches(tournament.stageIds[0])) {
        expect(match.mr).toBe(8);
        expect(match.tv_delay).toBe(30);
      }
    });
  });

  it("leaves every setting of a match outside a tournament editable", async () => {
    const match = await fx.match({ type: "Wingman", mr: 8 });

    await update(match.options_id, "mr = 12, overtime = NOT overtime");

    expect((await optionsRow(match.options_id)).mr).toBe(12);
  });
});
