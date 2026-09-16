import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

describe("tournament substitutes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentSubstitutesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199990000000n);
    await seedRegionWithServer(postgres, "TestA");
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

  const createTournament = async ({
    type,
    substitutes,
  }: {
    type: "Duel" | "Wingman";
    substitutes: number;
  }) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, $1, id, false, true, '{TestA}', $2
       FROM map_pools WHERE type = $1 AND seed = true RETURNING id`,
      [type, substitutes],
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
      [fx.nextName("cup"), organizer, options.id],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    return { id: tournament.id, organizer, optionsId: options.id };
  };

  const setStatus = (tournamentId: string, organizer: string, status: string) =>
    runAsUser(postgres, organizer, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const setSubstitutesEnabled = (tournamentId: string, enabled: boolean) =>
    postgres.query(
      "UPDATE tournaments SET substitutes_enabled = $1 WHERE id = $2",
      [enabled, tournamentId],
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

  const addRosterPlayer = (
    tournamentId: string,
    tournamentTeamId: string,
    owner: string,
  ) =>
    runAsUser(postgres, owner, "admin", async (query) => {
      const player = await fx.player();
      await query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [tournamentTeamId, player, tournamentId],
      );
    });

  const rosterSteamIds = async (tournamentTeamId: string) => {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      "SELECT player_steam_id FROM tournament_team_roster WHERE tournament_team_id = $1",
      [tournamentTeamId],
    );
    return rows.map((row) => row.player_steam_id);
  };

  const lineupSizes = async (tournamentId: string) => {
    const [row] = await postgres.query<
      Array<{ min_players: number; max_players: number }>
    >(
      `SELECT tournament_min_players_per_lineup(t) AS min_players,
              tournament_max_players_per_lineup(t) AS max_players
       FROM tournaments t WHERE t.id = $1`,
      [tournamentId],
    );
    return row;
  };

  const seedBracket = async (
    tournament: { id: string; organizer: string },
    mates: number,
  ) => {
    await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await registerTeam(tournament.id, await fx.team(mates));
    }
    await setStatus(tournament.id, tournament.organizer, "RegistrationClosed");

    return postgres.query<
      Array<{
        id: string;
        match_options_id: string;
        lineup_1_id: string;
        lineup_2_id: string;
        max_players: number;
      }>
    >(
      `SELECT m.id, m.match_options_id, m.lineup_1_id, m.lineup_2_id,
              match_max_players_per_lineup(m) AS max_players
       FROM tournament_brackets tb
       INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       INNER JOIN matches m ON m.id = tb.match_id
       WHERE ts.tournament_id = $1
       ORDER BY tb.round, tb.match_number`,
      [tournament.id],
    );
  };

  const seatedCount = async (lineupId: string) => {
    const [row] = await postgres.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM match_lineup_players WHERE match_lineup_id = $1",
      [lineupId],
    );
    return row.count;
  };

  describe("Duel tournaments", () => {
    it("caps the lineup at one player whatever the substitute count", async () => {
      const tournament = await createTournament({
        type: "Duel",
        substitutes: 2,
      });

      expect(await lineupSizes(tournament.id)).toEqual({
        min_players: 1,
        max_players: 1,
      });
    });

    it("registering a team rosters only the captain", async () => {
      const tournament = await createTournament({
        type: "Duel",
        substitutes: 2,
      });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(2);

      const tournamentTeamId = await registerTeam(tournament.id, team);

      expect(await rosterSteamIds(tournamentTeamId)).toEqual([team.owner]);
    });

    it("rejects a stand-in added to the roster", async () => {
      const tournament = await createTournament({
        type: "Duel",
        substitutes: 2,
      });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(0);
      const tournamentTeamId = await registerTeam(tournament.id, team);

      await expect(
        addRosterPlayer(tournament.id, tournamentTeamId, team.owner),
      ).rejects.toThrow(/too many players/i);
    });

    it("seats one player per side and refuses a stand-in on the match", async () => {
      const tournament = await createTournament({
        type: "Duel",
        substitutes: 2,
      });

      const matches = await seedBracket(tournament, 2);

      expect(matches.length).toBe(2);
      for (const match of matches) {
        expect(match.max_players).toBe(1);
        expect(await seatedCount(match.lineup_1_id)).toBe(1);
        expect(await seatedCount(match.lineup_2_id)).toBe(1);
      }

      await expect(fx.lineupPlayer(matches[0].lineup_1_id)).rejects.toThrow(
        /Max number of players/i,
      );
    });

    it("raising a scheduled match's substitutes does not reopen stand-in slots", async () => {
      const tournament = await createTournament({
        type: "Duel",
        substitutes: 0,
      });
      const [match] = await seedBracket(tournament, 0);

      await postgres.query(
        "UPDATE match_options SET number_of_substitutes = 3 WHERE id = $1",
        [match.match_options_id],
      );

      const [row] = await postgres.query<Array<{ max_players: number }>>(
        "SELECT match_max_players_per_lineup(m) AS max_players FROM matches m WHERE m.id = $1",
        [match.id],
      );
      expect(row.max_players).toBe(1);
      await expect(fx.lineupPlayer(match.lineup_1_id)).rejects.toThrow(
        /Max number of players/i,
      );
    });
  });

  describe("substitutes_enabled", () => {
    it("defaults to on", async () => {
      const tournament = await createTournament({
        type: "Wingman",
        substitutes: 2,
      });

      const [row] = await postgres.query<
        Array<{ substitutes_enabled: boolean }>
      >("SELECT substitutes_enabled FROM tournaments WHERE id = $1", [
        tournament.id,
      ]);
      expect(row.substitutes_enabled).toBe(true);
      expect(await lineupSizes(tournament.id)).toEqual({
        min_players: 2,
        max_players: 4,
      });
    });

    it("turning it off caps a Wingman tournament at the starting lineup, and back on restores it", async () => {
      const tournament = await createTournament({
        type: "Wingman",
        substitutes: 2,
      });

      await setSubstitutesEnabled(tournament.id, false);
      expect(await lineupSizes(tournament.id)).toEqual({
        min_players: 2,
        max_players: 2,
      });

      await setSubstitutesEnabled(tournament.id, true);
      expect(await lineupSizes(tournament.id)).toEqual({
        min_players: 2,
        max_players: 4,
      });
    });

    it("turned off, rosters and scheduled matches only take the starting lineup", async () => {
      const tournament = await createTournament({
        type: "Wingman",
        substitutes: 2,
      });
      await setSubstitutesEnabled(tournament.id, false);

      const matches = await seedBracket(tournament, 3);

      const teams = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1",
        [tournament.id],
      );
      for (const team of teams) {
        expect((await rosterSteamIds(team.id)).length).toBe(2);
      }
      for (const match of matches) {
        expect(match.max_players).toBe(2);
        expect(await seatedCount(match.lineup_1_id)).toBe(2);
        expect(await seatedCount(match.lineup_2_id)).toBe(2);
      }
    });

    it("can be turned back on but not off once registration has closed", async () => {
      const tournament = await createTournament({
        type: "Wingman",
        substitutes: 2,
      });
      await seedBracket(tournament, 1);

      await expect(setSubstitutesEnabled(tournament.id, false)).rejects.toThrow(
        /only be turned off before registration closes/i,
      );

      const withoutSubstitutes = await createTournament({
        type: "Wingman",
        substitutes: 2,
      });
      await setSubstitutesEnabled(withoutSubstitutes.id, false);
      await seedBracket(withoutSubstitutes, 1);

      await expect(
        setSubstitutesEnabled(withoutSubstitutes.id, true),
      ).resolves.toBeDefined();
    });

    it("a roster already over the new cap can still check in and drop its stand-ins", async () => {
      const tournament = await createTournament({
        type: "Wingman",
        substitutes: 1,
      });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(2);
      const tournamentTeamId = await registerTeam(tournament.id, team);
      expect((await rosterSteamIds(tournamentTeamId)).length).toBe(3);

      await setSubstitutesEnabled(tournament.id, false);

      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `UPDATE tournament_team_roster SET checked_in_at = now()
           WHERE tournament_team_id = $1 AND player_steam_id = $2`,
          [tournamentTeamId, team.owner],
        ),
      );

      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `DELETE FROM tournament_team_roster
           WHERE tournament_team_id = $1 AND player_steam_id <> $2`,
          [tournamentTeamId, team.owner],
        ),
      );
      expect(await rosterSteamIds(tournamentTeamId)).toEqual([team.owner]);
    });

    it("lowering the substitute count below a roster does not lock that roster", async () => {
      const tournament = await createTournament({
        type: "Wingman",
        substitutes: 1,
      });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(2);
      const tournamentTeamId = await registerTeam(tournament.id, team);

      await postgres.query(
        "UPDATE match_options SET number_of_substitutes = 0 WHERE id = $1",
        [tournament.optionsId],
      );

      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `UPDATE tournament_team_roster SET checked_in_at = now()
           WHERE tournament_team_id = $1`,
          [tournamentTeamId],
        ),
      );

      await expect(
        addRosterPlayer(tournament.id, tournamentTeamId, team.owner),
      ).rejects.toThrow(/too many players/i);
    });
  });

  describe("outside tournaments", () => {
    it("a Duel match keeps its configured substitute slots", async () => {
      const match = await fx.match({ type: "Duel", substitutes: 2 });

      const [row] = await postgres.query<Array<{ max_players: number }>>(
        "SELECT match_max_players_per_lineup(m) AS max_players FROM matches m WHERE m.id = $1",
        [match.id],
      );
      expect(row.max_players).toBe(3);

      for (let i = 0; i < 3; i++) {
        await fx.lineupPlayer(match.lineup_1_id);
      }
      await expect(fx.lineupPlayer(match.lineup_1_id)).rejects.toThrow(
        /Max number of players/i,
      );
    });
  });
});
