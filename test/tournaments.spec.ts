import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the tournament SQL end to end: status-transition guards
// (tbu_tournaments), stage validation, team registration (roster copy +
// eligibility), bracket seeding on registration close, match scheduling,
// winner propagation through the bracket (update_tournament_bracket), the
// min-teams auto-cancel, automatic finish, and trophy calculation.
describe("tournaments (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199000000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // Matches must go before tournaments: deleting a bracket deletes its match,
    // whose after-delete trigger updates sibling brackets that are mid-cascade
    // ("tuple to be deleted was already modified") if the tournament goes first.
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const seedPlayer = () => fx.player();

  // A team whose roster is the owner plus `mates` extra players. Wingman
  // tournaments need two per lineup, so one mate makes a team eligible.
  const createTeam = (mates = 1) => fx.team(mates);

  const createTournament = async ({
    withStage = true,
    start = "1 day",
    substitutes = 0,
  } = {}) => {
    const organizer = await seedPlayer();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}', $1
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      [substitutes],
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + $2::interval, $3, $4, 'Setup') RETURNING id`,
      [fx.nextName("cup"), start, organizer, options.id],
    );
    if (withStage) {
      await postgres.query(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 1, 4, 8)`,
        [tournament.id],
      );
    }
    return { id: tournament.id, organizer };
  };

  const setStatus = (tournamentId: string, organizer: string, status: string) =>
    runAsUser(postgres, organizer, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const registerTeam = (
    tournamentId: string,
    team: { id: string; owner: string },
  ) =>
    runAsUser(postgres, team.owner, "admin", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id`,
        [tournamentId, team.id],
      )) as Array<{ id: string }>;
      return row.id;
    });

  const getTournament = async (id: string) => {
    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournaments WHERE id = $1",
      [id],
    );
    return row;
  };

  type BracketRow = {
    id: string;
    round: number;
    match_number: number;
    match_id: string | null;
    tournament_team_id_1: string | null;
    tournament_team_id_2: string | null;
    finished: boolean;
  };

  const getBrackets = (tournamentId: string) =>
    postgres.query<Array<BracketRow>>(
      `SELECT tb.id, tb.round, tb.match_number, tb.match_id,
              tb.tournament_team_id_1, tb.tournament_team_id_2, tb.finished
       FROM tournament_brackets tb
       INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       WHERE ts.tournament_id = $1
       ORDER BY tb.round, tb.match_number`,
      [tournamentId],
    );

  const winMatch = (matchId: string, lineup: "lineup_1_id" | "lineup_2_id") =>
    postgres.query(
      `UPDATE matches SET winning_lineup_id = ${lineup} WHERE id = $1`,
      [matchId],
    );

  // Registration through bracket seeding with four eligible teams.
  const seedFourTeamCup = async ({ substitutes = 0, mates = 1 } = {}) => {
    const tournament = await createTournament({ substitutes });
    await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    const teams = [] as Array<{ id: string; owner: string }>;
    for (let i = 0; i < 4; i++) {
      teams.push(await createTeam(mates));
    }
    for (const team of teams) {
      await registerTeam(tournament.id, team);
    }
    await setStatus(tournament.id, tournament.organizer, "RegistrationClosed");
    return { tournament, teams };
  };

  // The tournament_teams id for a registered team.
  const getTournamentTeamId = async (tournamentId: string, teamId: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2",
      [tournamentId, teamId],
    );
    return row.id;
  };

  // Removes exactly one non-owner roster member as the team owner.
  const removeRosterMate = (
    tournamentId: string,
    team: { id: string; owner: string },
  ) =>
    runAsUser(postgres, team.owner, "admin", (query) =>
      query(
        `DELETE FROM tournament_team_roster
         WHERE ctid = (
           SELECT ttr.ctid FROM tournament_team_roster ttr
           WHERE ttr.tournament_team_id = (
             SELECT id FROM tournament_teams
             WHERE tournament_id = $1 AND team_id = $2
           )
           AND ttr.player_steam_id != $3
           LIMIT 1
         )`,
        [tournamentId, team.id, team.owner],
      ),
    );

  describe("status transition guards", () => {
    it("cannot open registration without stages", async () => {
      const t = await createTournament({ withStage: false });
      await expect(
        setStatus(t.id, t.organizer, "RegistrationOpen"),
      ).rejects.toThrow(/Cannot open tournament registration/i);
    });

    it("cannot open registration after the start date has passed", async () => {
      const t = await createTournament({ start: "-1 hour" });
      await expect(
        setStatus(t.id, t.organizer, "RegistrationOpen"),
      ).rejects.toThrow(/Cannot open tournament registration/i);
    });

    it("a non-organizer cannot open registration", async () => {
      const t = await createTournament();
      const stranger = await seedPlayer();
      await expect(
        runAsUser(postgres, stranger, "user", (query) =>
          query(
            "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
            [t.id],
          ),
        ),
      ).rejects.toThrow(/Cannot open tournament registration/i);
    });

    it("manually finishing is reserved for admins", async () => {
      const t = await createTournament();
      const stranger = await seedPlayer();
      await expect(
        runAsUser(postgres, stranger, "user", (query) =>
          query("UPDATE tournaments SET status = 'Finished' WHERE id = $1", [
            t.id,
          ]),
        ),
      ).rejects.toThrow(/handled automatically/i);
    });

    it("rejects a first stage smaller than four teams per group", async () => {
      const t = await createTournament({ withStage: false });
      await expect(
        postgres.query(
          `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
           VALUES ($1, 'SingleElimination', 1, 2, 8)`,
          [t.id],
        ),
      ).rejects.toThrow(/at least 4 teams/i);
    });
  });

  describe("registration and eligibility", () => {
    it("registering a team copies its roster and marks it eligible", async () => {
      const t = await createTournament();
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const team = await createTeam();

      const tournamentTeamId = await registerTeam(t.id, team);

      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM tournament_team_roster WHERE tournament_team_id = $1",
        [tournamentTeamId],
      );
      // Wingman: owner + one mate fill the two slots.
      expect(roster.length).toBe(2);
      expect(roster.map((r) => r.player_steam_id)).toContain(team.owner);

      const [row] = await postgres.query<
        Array<{ eligible_at: Date | null; captain_steam_id: string }>
      >(
        "SELECT eligible_at, captain_steam_id FROM tournament_teams WHERE id = $1",
        [tournamentTeamId],
      );
      expect(row.eligible_at).not.toBeNull();
      // Captain falls back to the team's own captain (the owner).
      expect(row.captain_steam_id).toBe(team.owner);
    });

    it("a team below the minimum roster stays ineligible", async () => {
      const t = await createTournament();
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const team = await createTeam(0); // owner only, Wingman needs 2

      const tournamentTeamId = await registerTeam(t.id, team);

      const [row] = await postgres.query<Array<{ eligible_at: Date | null }>>(
        "SELECT eligible_at FROM tournament_teams WHERE id = $1",
        [tournamentTeamId],
      );
      expect(row.eligible_at).toBeNull();
    });

    it("rejects roster additions beyond the lineup capacity", async () => {
      const t = await createTournament();
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const team = await createTeam();
      const tournamentTeamId = await registerTeam(t.id, team);
      const extra = await seedPlayer();

      await expect(
        runAsUser(postgres, team.owner, "admin", (query) =>
          query(
            `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
             VALUES ($1, $2, $3)`,
            [tournamentTeamId, extra, t.id],
          ),
        ),
      ).rejects.toThrow(/too many players/i);
    });

    it("dropping below the minimum revokes eligibility and the seed", async () => {
      const t = await createTournament();
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const team = await createTeam();
      const tournamentTeamId = await registerTeam(t.id, team);

      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `DELETE FROM tournament_team_roster
           WHERE tournament_team_id = $1 AND player_steam_id != $2`,
          [tournamentTeamId, team.owner],
        ),
      );

      const [row] = await postgres.query<
        Array<{ eligible_at: Date | null; seed: number | null }>
      >("SELECT eligible_at, seed FROM tournament_teams WHERE id = $1", [
        tournamentTeamId,
      ]);
      expect(row.eligible_at).toBeNull();
      expect(row.seed).toBeNull();
    });
  });

  describe("roster lock once the bracket is seeded", () => {
    it("cannot drop a roster below the minimum after registration closes", async () => {
      const { tournament, teams } = await seedFourTeamCup();

      await expect(removeRosterMate(tournament.id, teams[0])).rejects.toThrow(
        /minimum lineup/i,
      );

      // Eligibility and seed are untouched — the removal never happened.
      const teamId = await getTournamentTeamId(tournament.id, teams[0].id);
      const [row] = await postgres.query<
        Array<{ eligible_at: Date | null; seed: number | null }>
      >("SELECT eligible_at, seed FROM tournament_teams WHERE id = $1", [
        teamId,
      ]);
      expect(row.eligible_at).not.toBeNull();
      expect(row.seed).not.toBeNull();
    });

    it("cannot drop a roster below the minimum while the tournament is live", async () => {
      const { tournament, teams } = await seedFourTeamCup();
      await setStatus(tournament.id, tournament.organizer, "Live");

      await expect(removeRosterMate(tournament.id, teams[0])).rejects.toThrow(
        /minimum lineup/i,
      );
    });

    it("allows swapping a player out when a substitute keeps the lineup at the minimum", async () => {
      // Wingman needs two per lineup; one substitute slot lets a three-player
      // team drop back to two.
      const { tournament, teams } = await seedFourTeamCup({
        substitutes: 1,
        mates: 2,
      });
      const teamId = await getTournamentTeamId(tournament.id, teams[0].id);

      await removeRosterMate(tournament.id, teams[0]);

      const [countRow] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) FROM tournament_team_roster WHERE tournament_team_id = $1",
        [teamId],
      );
      expect(Number(countRow.count)).toBe(2);

      const [row] = await postgres.query<Array<{ eligible_at: Date | null }>>(
        "SELECT eligible_at FROM tournament_teams WHERE id = $1",
        [teamId],
      );
      expect(row.eligible_at).not.toBeNull();
    });

    it("still lets an entire team be removed, cascading its roster", async () => {
      const { tournament, teams } = await seedFourTeamCup();
      const teamId = await getTournamentTeamId(tournament.id, teams[0].id);

      await runAsUser(postgres, teams[0].owner, "admin", (query) =>
        query("DELETE FROM tournament_teams WHERE id = $1", [teamId]),
      );

      const rows = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE id = $1",
        [teamId],
      );
      expect(rows.length).toBe(0);
    });
  });

  describe("bracket seeding and progression", () => {
    it("closing registration seeds the single-elimination bracket and schedules round 1", async () => {
      const { tournament } = await seedFourTeamCup();

      const brackets = await getBrackets(tournament.id);
      expect(brackets.map((b) => b.round)).toEqual([1, 1, 2]);

      const round1 = brackets.filter((b) => b.round === 1);
      for (const bracket of round1) {
        expect(bracket.tournament_team_id_1).not.toBeNull();
        expect(bracket.tournament_team_id_2).not.toBeNull();
        expect(bracket.match_id).not.toBeNull();
      }

      const final = brackets.find((b) => b.round === 2)!;
      expect(final.tournament_team_id_1).toBeNull();
      expect(final.tournament_team_id_2).toBeNull();
      expect(final.match_id).toBeNull();
    });

    it("winners propagate into the final, which finishes the tournament and awards trophies", async () => {
      const { tournament } = await seedFourTeamCup();
      await setStatus(tournament.id, tournament.organizer, "Live");
      expect((await getTournament(tournament.id)).status).toBe("Live");

      let brackets = await getBrackets(tournament.id);
      const round1 = brackets.filter((b) => b.round === 1);
      await winMatch(round1[0].match_id!, "lineup_1_id");
      await winMatch(round1[1].match_id!, "lineup_2_id");

      brackets = await getBrackets(tournament.id);
      const final = brackets.find((b) => b.round === 2)!;
      const expectedFinalists = [
        brackets.find((b) => b.round === 1 && b.match_number === 1)!
          .tournament_team_id_1,
        brackets.find((b) => b.round === 1 && b.match_number === 2)!
          .tournament_team_id_2,
      ].sort();
      expect(
        [final.tournament_team_id_1, final.tournament_team_id_2].sort(),
      ).toEqual(expectedFinalists);
      expect(final.match_id).not.toBeNull();
      expect(
        brackets.filter((b) => b.round === 1).every((b) => b.finished),
      ).toBe(true);

      await winMatch(final.match_id!, "lineup_1_id");

      expect((await getTournament(tournament.id)).status).toBe("Finished");

      const trophies = await postgres.query<
        Array<{
          placement: number;
          tournament_team_id: string;
          manual: boolean;
        }>
      >(
        `SELECT placement, tournament_team_id, manual FROM tournament_trophies
         WHERE tournament_id = $1 ORDER BY placement`,
        [tournament.id],
      );
      expect(trophies.length).toBeGreaterThan(0);
      expect(trophies.every((t) => t.manual === false)).toBe(true);
      // The final's winner holds placement 1.
      const champions = trophies.filter((t) => Number(t.placement) === 1);
      const [finalAfter] = (await getBrackets(tournament.id)).filter(
        (b) => b.round === 2,
      );
      expect(
        champions.every(
          (t) => t.tournament_team_id === finalAfter.tournament_team_id_1,
        ),
      ).toBe(true);
    });

    it("going Live without enough eligible teams auto-cancels", async () => {
      const tournament = await createTournament();
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      // Three eligible teams plus one ineligible: min_teams is 4.
      for (let i = 0; i < 3; i++) {
        await registerTeam(tournament.id, await createTeam());
      }
      await registerTeam(tournament.id, await createTeam(0));
      await setStatus(
        tournament.id,
        tournament.organizer,
        "RegistrationClosed",
      );

      await setStatus(tournament.id, tournament.organizer, "Live");

      expect((await getTournament(tournament.id)).status).toBe(
        "CancelledMinTeams",
      );
    });

    it("teams cannot leave once the tournament is decided", async () => {
      const { tournament } = await seedFourTeamCup();
      await setStatus(tournament.id, tournament.organizer, "Live");

      let brackets = await getBrackets(tournament.id);
      for (const bracket of brackets.filter((b) => b.round === 1)) {
        await winMatch(bracket.match_id!, "lineup_1_id");
      }
      brackets = await getBrackets(tournament.id);
      await winMatch(
        brackets.find((b) => b.round === 2)!.match_id!,
        "lineup_1_id",
      );
      expect((await getTournament(tournament.id)).status).toBe("Finished");

      await expect(
        postgres.query(
          "DELETE FROM tournament_teams WHERE tournament_id = $1",
          [tournament.id],
        ),
      ).rejects.toThrow(/Cannot leave/i);
    });

    it("disabling trophies wipes auto placements; re-enabling rebuilds them", async () => {
      const { tournament } = await seedFourTeamCup();
      await setStatus(tournament.id, tournament.organizer, "Live");

      let brackets = await getBrackets(tournament.id);
      for (const bracket of brackets.filter((b) => b.round === 1)) {
        await winMatch(bracket.match_id!, "lineup_1_id");
      }
      brackets = await getBrackets(tournament.id);
      await winMatch(
        brackets.find((b) => b.round === 2)!.match_id!,
        "lineup_1_id",
      );

      const count = async () =>
        Number(
          (
            await postgres.query<Array<{ c: string }>>(
              "SELECT count(*) AS c FROM tournament_trophies WHERE tournament_id = $1",
              [tournament.id],
            )
          )[0].c,
        );
      expect(await count()).toBeGreaterThan(0);

      await postgres.query(
        "UPDATE tournaments SET trophies_enabled = false WHERE id = $1",
        [tournament.id],
      );
      expect(await count()).toBe(0);

      await postgres.query(
        "UPDATE tournaments SET trophies_enabled = true WHERE id = $1",
        [tournament.id],
      );
      expect(await count()).toBeGreaterThan(0);
    });
  });
});
