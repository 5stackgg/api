import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { ProcessTournamentCheckIn } from "./../src/matches/jobs/ProcessTournamentCheckIn";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Exercises the registration-rule gates (min_role / ELO range), the optional
// check-in window (schedule freeze, auto stamp, no-show exclusion, CheckInReview
// hold) and the free-agent draft.
describe("tournament check-in, registration rules and free agents (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentCheckInTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561197000000000n);
    await fx.region("TestCI");
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
    start = "1 day",
    type = "Wingman",
    maxTeams = 8,
    columns = {} as Record<string, string | number | boolean>,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, $1, id, false, true, '{TestCI}', 0
       FROM map_pools WHERE type = $1 AND seed = true RETURNING id`,
      [type],
    );

    const names = Object.keys(columns);
    const extraCols = names.map((n) => `, "${n}"`).join("");
    const extraVals = names.map((_, i) => `, $${i + 5}`).join("");

    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status${extraCols})
       VALUES ($1, now() + $2::interval, $3, $4, 'Setup'${extraVals}) RETURNING id`,
      [
        fx.nextName("cup"),
        start,
        organizer,
        options.id,
        ...names.map((n) => columns[n]),
      ],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, $2)`,
      [tournament.id, maxTeams],
    );
    return { id: tournament.id, organizer };
  };

  const setStatus = (
    tournamentId: string,
    actor: string,
    status: string,
    role = "admin",
  ) =>
    runAsUser(postgres, actor, role, (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const registerFreeAgent = (
    tournamentId: string,
    steamId: string,
    createdAt?: string,
  ) =>
    postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id, created_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()))`,
      [tournamentId, steamId, createdAt ?? null],
    );

  const registerTeam = async (
    tournamentId: string,
    name: string,
    players: Array<string>,
  ) => {
    const [team] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [tournamentId, name, players[0]],
    );

    for (const player of players) {
      // tbi_tournament_team_roster reads hasura.user unconditionally, so a
      // roster insert has to arrive with a session like a real request.
      await runAsUser(postgres, player, "admin", (query) =>
        query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [team.id, player, tournamentId],
        ),
      );
    }

    return team.id;
  };

  const teamCheckedIn = async (teamId: string) => {
    const [row] = await postgres.query<Array<{ checked_in_at: Date | null }>>(
      "SELECT checked_in_at FROM tournament_teams WHERE id = $1",
      [teamId],
    );
    return row.checked_in_at !== null;
  };

  const confirmPlayer = (teamId: string, steamId: string) =>
    postgres.query(
      `UPDATE tournament_team_roster SET checked_in_at = now()
        WHERE tournament_team_id = $1 AND player_steam_id = $2`,
      [teamId, steamId],
    );

  const withdrawPlayer = (teamId: string, steamId: string) =>
    postgres.query(
      `UPDATE tournament_team_roster SET checked_in_at = NULL
        WHERE tournament_team_id = $1 AND player_steam_id = $2`,
      [teamId, steamId],
    );

  describe("registration requirements", () => {
    it("rejects a roster addition for a player below min_role", async () => {
      const t = await createTournament({
        columns: { min_role: "verified_user" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const owner = await fx.player();
      await postgres.query(
        "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
        [owner],
      );
      const outsider = await fx.player();

      const teamId = await runAsUser(postgres, owner, "user", async (query) => {
        const [row] = (await query(
          `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [t.id, fx.nextName("pickup"), owner],
        )) as Array<{ id: string }>;
        return row.id;
      });

      await expect(
        runAsUser(postgres, owner, "user", (query) =>
          query(
            `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
             VALUES ($1, $2, $3)`,
            [teamId, outsider, t.id],
          ),
        ),
      ).rejects.toThrow(/entry requirements/i);
    });

    it("treats a player with no rated match as the starting ELO", async () => {
      const t = await createTournament({ columns: { min_elo: 4000 } });
      const player = await fx.player();

      const [row] = await postgres.query<Array<{ ok: boolean }>>(
        "SELECT player_meets_tournament_requirements($1, $2) AS ok",
        [t.id, player],
      );
      expect(row.ok).toBe(true);

      await postgres.query(
        "UPDATE tournaments SET min_elo = 6000 WHERE id = $1",
        [t.id],
      );
      const [tooLow] = await postgres.query<Array<{ ok: boolean }>>(
        "SELECT player_meets_tournament_requirements($1, $2) AS ok",
        [t.id, player],
      );
      expect(tooLow.ok).toBe(false);
    });
  });

  describe("check-in window", () => {
    it("is closed when check_in_required is false", async () => {
      const t = await createTournament({ start: "10 minutes" });
      const [row] = await postgres.query<
        Array<{ started: boolean; open: boolean }>
      >(
        `SELECT tournament_check_in_started(t) AS started,
                tournament_check_in_open(t) AS open
         FROM tournaments t WHERE t.id = $1`,
        [t.id],
      );
      expect(row.started).toBe(false);
      expect(row.open).toBe(false);
    });

    it("opens inside the window and latches once stamped", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      const [row] = await postgres.query<
        Array<{ started: boolean; open: boolean }>
      >(
        `SELECT tournament_check_in_started(t) AS started,
                tournament_check_in_open(t) AS open
         FROM tournaments t WHERE t.id = $1`,
        [t.id],
      );
      expect(row.started).toBe(true);
      expect(row.open).toBe(true);
    });

    it("freezes the schedule once check-in has started", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });

      await expect(
        postgres.query(
          "UPDATE tournaments SET start = now() + interval '3 days' WHERE id = $1",
          [t.id],
        ),
      ).rejects.toThrow(/check-in has already started/i);

      await expect(
        postgres.query(
          "UPDATE tournaments SET check_in_opens_before_minutes = 120 WHERE id = $1",
          [t.id],
        ),
      ).rejects.toThrow(/check-in has already started/i);

      // Extending the deadline is the sanctioned escape hatch and stays open.
      await postgres.query(
        "UPDATE tournaments SET check_in_ends_at = now() + interval '20 minutes' WHERE id = $1",
        [t.id],
      );
    });

    it("stamps a team that registers after the window opened", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      await postgres.query(
        "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
        [t.id],
      );

      const owner = await fx.player();
      const [team] = await postgres.query<
        Array<{ checked_in_at: Date | null }>
      >(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, $2, $3, $3) RETURNING checked_in_at`,
        [t.id, fx.nextName("late"), owner],
      );
      expect(team.checked_in_at).not.toBeNull();
    });

    // The team is registered BEFORE the window opens so nothing auto-stamps it:
    // its checked_in_at is then the roll-up's work and nothing else. Registered
    // inside the window instead, the team starts out stamped and the roll-up
    // could be deleted outright without the assertions noticing.
    it("rolls per-player confirmations up into the team in Players mode", async () => {
      const t = await createTournament({
        start: "3 days",
        columns: { check_in_required: true, check_in_setting: "Players" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const [owner, mate] = await fx.players(2);
      const teamId = await registerTeam(t.id, "Roster", [owner, mate]);
      expect(await teamCheckedIn(teamId)).toBe(false);

      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '30 minutes' WHERE id = $1",
        [t.id],
      );

      // Wingman fields two, so one confirmation is not enough.
      await confirmPlayer(teamId, owner);
      expect(await teamCheckedIn(teamId)).toBe(false);

      await confirmPlayer(teamId, mate);
      expect(await teamCheckedIn(teamId)).toBe(true);

      // Withdrawing a confirmation from a satisfied roll-up is the only thing
      // that may take the team back out.
      await withdrawPlayer(teamId, mate);
      expect(await teamCheckedIn(teamId)).toBe(false);

      await confirmPlayer(teamId, mate);
      expect(await teamCheckedIn(teamId)).toBe(true);
    });

    // The registration auto-stamp and the per-player roll-up meet here: a team
    // that signed up mid-window is already checked in, and the first player to
    // do what the UI asked used to wipe it -- one confirmation being below the
    // minimum lineup. The same branch silently reversed an organizer re-admit.
    it("never lets the first player to confirm un-check their own team", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true, check_in_setting: "Players" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const players = await fx.players(2);
      const teamId = await registerTeam(t.id, "Auto", players);
      expect(await teamCheckedIn(teamId)).toBe(true);

      await confirmPlayer(teamId, players[0]);
      expect(await teamCheckedIn(teamId)).toBe(true);
    });

    // Removing the people who confirmed is a withdrawal with the row deleted:
    // left to the UPDATE path alone, a captain could seed an unconfirmed lineup
    // simply by dropping the players whose stamps carried the team.
    it("drops the roll-up when a confirmed player leaves the roster", async () => {
      const t = await createTournament({
        start: "3 days",
        columns: { check_in_required: true, check_in_setting: "Players" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const [owner, mate] = await fx.players(2);
      const teamId = await registerTeam(t.id, "Roster", [owner, mate]);

      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '30 minutes' WHERE id = $1",
        [t.id],
      );

      await confirmPlayer(teamId, owner);
      await confirmPlayer(teamId, mate);
      expect(await teamCheckedIn(teamId)).toBe(true);

      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_team_id = $1 AND player_steam_id = $2`,
        [teamId, mate],
      );
      expect(await teamCheckedIn(teamId)).toBe(false);
    });

    // The mirror of the re-admit rule below: a player who never confirmed was
    // not holding the roll-up up, so their removal cannot break one.
    it("leaves an auto-stamped team alone when an unconfirmed player leaves", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true, check_in_setting: "Players" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const players = await fx.players(2);
      const teamId = await registerTeam(t.id, "Auto", players);
      expect(await teamCheckedIn(teamId)).toBe(true);

      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_team_id = $1 AND player_steam_id = $2`,
        [teamId, players[1]],
      );
      expect(await teamCheckedIn(teamId)).toBe(true);
    });

    it("never lets a withdrawal reverse an organizer re-admit", async () => {
      const t = await createTournament({
        start: "3 days",
        columns: { check_in_required: true, check_in_setting: "Players" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const players = await fx.players(2);
      const teamId = await registerTeam(t.id, "Missed", players);

      // One player confirmed, the team never reached the bar, the organizer
      // re-admitted it anyway. Losing that one confirmation is not a drop from
      // a satisfied roll-up, so the re-admission stands.
      await confirmPlayer(teamId, players[0]);
      await postgres.query(
        "UPDATE tournament_teams SET checked_in_at = now() WHERE id = $1",
        [teamId],
      );

      await withdrawPlayer(teamId, players[0]);
      expect(await teamCheckedIn(teamId)).toBe(true);
    });

    it("drops a no-show from seeding without deleting it, and re-admits on demand", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      await postgres.query(
        "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
        [t.id],
      );

      await registerTeam(t.id, "A", await fx.players(2));
      const teamB = { id: await registerTeam(t.id, "B", await fx.players(2)) };

      // The exclusion keys off check_in_ends_at, which only a real opened
      // window ever stamps; without it nobody can be a no-show.
      await postgres.query(
        "UPDATE tournaments SET check_in_ends_at = now() + interval '10 minutes' WHERE id = $1",
        [t.id],
      );

      // Both were auto-stamped on insert (the window is open); clear B to make
      // it a genuine no-show.
      await postgres.query(
        "UPDATE tournament_teams SET checked_in_at = NULL WHERE id = $1",
        [teamB.id],
      );

      await postgres.query(
        "SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1",
        [t.id],
      );

      const seeded = await postgres.query<
        Array<{ id: string; seed: number | null; eligible_at: Date | null }>
      >(
        "SELECT id, seed, eligible_at FROM tournament_teams WHERE tournament_id = $1 ORDER BY name",
        [t.id],
      );
      expect(seeded).toHaveLength(2);
      expect(seeded[0].seed).not.toBeNull();
      expect(seeded[1].seed).toBeNull();
      expect(seeded[1].eligible_at).toBeNull();

      // Re-admit: stamp and re-run. No row was ever deleted.
      await postgres.query(
        "UPDATE tournament_teams SET checked_in_at = now() WHERE id = $1",
        [teamB.id],
      );
      await postgres.query(
        "SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1",
        [t.id],
      );

      const readmitted = await postgres.query<Array<{ seed: number | null }>>(
        "SELECT seed FROM tournament_teams WHERE id = $1",
        [teamB.id],
      );
      expect(readmitted[0].seed).not.toBeNull();
    });
  });

  describe("CheckInReview", () => {
    it("holds out of RegistrationOpen and continues into RegistrationClosed", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      await setStatus(t.id, t.organizer, "CheckInReview");

      const [held] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(held.status).toBe("CheckInReview");

      // Nothing seeded on the way in.
      const brackets = await postgres.query<Array<{ id: string }>>(
        `SELECT tb.id FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1 AND tb.tournament_team_id_1 IS NOT NULL`,
        [t.id],
      );
      expect(brackets).toHaveLength(0);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      const [closed] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(closed.status).toBe("RegistrationClosed");
    });

    // Not what extendTournamentCheckIn does -- that leaves the tournament held
    // -- but an organizer deliberately enlarging the field still has to be able
    // to re-open signups out of the hold.
    it("allows an organizer back to RegistrationOpen", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      await setStatus(t.id, t.organizer, "CheckInReview");
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(row.status).toBe("RegistrationOpen");
    });

    it("still falls back to CancelledMinTeams when review proceeds short-handed", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const owner = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Lonely', $2, $2)`,
        [t.id, owner],
      );

      await setStatus(t.id, t.organizer, "CheckInReview");
      await setStatus(t.id, t.organizer, "Live");

      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(row.status).toBe("CancelledMinTeams");
    });

    // ProcessTournamentCheckIn writes on the API's pooled connection, which
    // never sets hasura.user. If the guards treated that as a denied session
    // the job could neither hold a tournament nor release one.
    it("lets a session-less job hold and then release a tournament", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      await postgres.query(
        "UPDATE tournaments SET status = 'CheckInReview' WHERE id = $1 AND status = 'RegistrationOpen'",
        [t.id],
      );
      const [held] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(held.status).toBe("CheckInReview");

      await postgres.query(
        "UPDATE tournaments SET status = 'RegistrationClosed' WHERE id = $1 AND status = 'CheckInReview'",
        [t.id],
      );
      const [released] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(released.status).toBe("RegistrationClosed");
    });

    it("refuses the hold when check-in is not required", async () => {
      const t = await createTournament({ start: "30 minutes" });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      await expect(
        setStatus(t.id, t.organizer, "CheckInReview"),
      ).rejects.toThrow(/check-in review/i);
    });

    it("refuses a non-organizer resolving the hold", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      await setStatus(t.id, t.organizer, "CheckInReview");

      const stranger = await fx.player();
      await expect(
        setStatus(t.id, stranger, "RegistrationClosed", "user"),
      ).rejects.toThrow(/organizer/i);
    });
  });

  describe("free agents", () => {
    it("refuses a free agent on a teams-only tournament", async () => {
      const t = await createTournament();
      const player = await fx.player();

      await expect(registerFreeAgent(t.id, player)).rejects.toThrow(
        /pre-formed teams/i,
      );
    });

    it("drafts full teams, honours registration order, and waitlists the rest", async () => {
      const t = await createTournament({
        maxTeams: 8,
        columns: { registration_type: "free_agents" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      // Wingman: two per team. Five signups -> two teams, one waitlisted, and
      // the waitlisted one must be the LAST to register.
      const players: Array<string> = [];
      for (let i = 0; i < 5; i++) {
        const p = await fx.player();
        players.push(p);
        await registerFreeAgent(
          t.id,
          p,
          new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        );
      }

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      const teams = await postgres.query<
        Array<{ id: string; name: string; team_id: string | null }>
      >(
        "SELECT id, name, team_id FROM tournament_teams WHERE tournament_id = $1 ORDER BY name",
        [t.id],
      );
      expect(teams).toHaveLength(2);
      expect(teams.map((row) => row.name)).toEqual(["Team 1", "Team 2"]);
      expect(teams.every((row) => row.team_id === null)).toBe(true);

      const rosters = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM tournament_team_roster WHERE tournament_id = $1`,
        [t.id],
      );
      expect(Number(rosters[0].count)).toBe(4);

      const agents = await postgres.query<
        Array<{ player_steam_id: string; status: string }>
      >(
        "SELECT player_steam_id, status FROM tournament_free_agents WHERE tournament_id = $1 ORDER BY created_at",
        [t.id],
      );
      expect(agents.slice(0, 4).every((a) => a.status === "drafted")).toBe(
        true,
      );
      expect(agents[4].status).toBe("waitlisted");
      expect(agents[4].player_steam_id).toBe(players[4]);

      // The generated teams are seeded by the normal pass, not left bare.
      const seeded = await postgres.query<Array<{ seed: number | null }>>(
        "SELECT seed FROM tournament_teams WHERE tournament_id = $1",
        [t.id],
      );
      expect(seeded.every((row) => row.seed !== null)).toBe(true);
    });

    it("tops a 'both' field up alongside the teams that registered", async () => {
      const t = await createTournament({
        columns: { registration_type: "both" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const owner = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Existing', $2, $2)`,
        [t.id, owner],
      );
      for (let i = 0; i < 4; i++) {
        await registerFreeAgent(t.id, await fx.player());
      }

      const [created] = await postgres.query<Array<{ created: number }>>(
        "SELECT draft_tournament_free_agent_teams($1) AS created",
        [t.id],
      );
      expect(created.created).toBe(2);

      // Numbered past the registered team rather than minting a second "Team 1".
      const teams = await postgres.query<
        Array<{ name: string; is_drafted: boolean }>
      >(
        "SELECT name, is_drafted FROM tournament_teams WHERE tournament_id = $1 ORDER BY name",
        [t.id],
      );
      expect(teams.map((row) => row.name)).toEqual([
        "Existing",
        "Team 2",
        "Team 3",
      ]);
      expect(teams.map((row) => row.is_drafted)).toEqual([false, true, true]);

      // Idempotent on the drafted teams: a second pass adds nothing.
      const [again] = await postgres.query<Array<{ created: number }>>(
        "SELECT draft_tournament_free_agent_teams($1) AS created",
        [t.id],
      );
      expect(again.created).toBe(0);
    });

    it("drafts on a straight Setup -> Live flip instead of cancelling", async () => {
      const t = await createTournament({
        maxTeams: 8,
        columns: { registration_type: "free_agents" },
      });

      for (let i = 0; i < 8; i++) {
        await registerFreeAgent(t.id, await fx.player());
      }

      await setStatus(t.id, t.organizer, "Live");

      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(row.status).toBe("Live");

      const teams = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1 AND is_drafted",
        [t.id],
      );
      expect(teams).toHaveLength(4);
    });
  });

  describe("invite only registration", () => {
    it("blocks a team, then lets the same player in once unlocked", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const owner = await fx.player();
      const insertTeam = () =>
        runAsUser(postgres, owner, "user", (query) =>
          query(
            `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
             VALUES ($1, $2, $3, $3)`,
            [t.id, fx.nextName("locked"), owner],
          ),
        );

      await expect(insertTeam()).rejects.toThrow(/invite only/i);

      await postgres.query(
        `INSERT INTO tournament_registration_unlocks (tournament_id, player_steam_id)
         VALUES ($1, $2)`,
        [t.id, owner],
      );

      await expect(insertTeam()).resolves.not.toThrow();
    });

    it("blocks a free agent who has not unlocked", async () => {
      const t = await createTournament({
        columns: { invite_only: true, registration_type: "free_agents" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const player = await fx.player();
      await expect(
        runAsUser(postgres, player, "user", (query) =>
          query(
            `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
             VALUES ($1, $2)`,
            [t.id, player],
          ),
        ),
      ).rejects.toThrow(/invite only/i);
    });

    it("never blocks the organizer or a session-less internal write", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const invited = await fx.player();
      await expect(
        runAsUser(postgres, t.organizer, "user", (query) =>
          query(
            `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
             VALUES ($1, $2, $3, $3)`,
            [t.id, fx.nextName("invited"), invited],
          ),
        ),
      ).resolves.not.toThrow();

      const internal = await fx.player();
      await expect(
        postgres.query(
          `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
           VALUES ($1, $2, $3, $3)`,
          [t.id, fx.nextName("internal"), internal],
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("leaderboard", () => {
    it("returns nothing for a Setup tournament to a guest", async () => {
      const t = await createTournament();

      const rows = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM get_tournament_leaderboard($1, $2::json)",
        [t.id, JSON.stringify({ "x-hasura-role": "guest" })],
      );
      expect(rows).toHaveLength(0);
    });
  });

  // Every case below was a live defect: the suite above stayed green through
  // all of them.
  describe("check-in windows that never opened", () => {
    // check_in_ends_at is stamped only by the open pass, which fires on
    // RegistrationOpen alone. An organizer who closes registration early
    // therefore leaves it NULL for good -- and the derived
    // "clock is past start - opens_before" said "check-in has started" anyway.
    const fullField = async (start: string) => {
      const t = await createTournament({
        start,
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      for (let i = 1; i <= 4; i++) {
        await registerTeam(t.id, `T${i}`, await fx.players(2));
      }

      return t;
    };

    it("does not cancel a fully rostered field when no window ever opened", async () => {
      const t = await fullField("3 days");

      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '30 minutes' WHERE id = $1",
        [t.id],
      );

      const [gate] = await postgres.query<
        Array<{ started: boolean; opened: boolean; min_teams: boolean }>
      >(
        `SELECT tournament_check_in_started(t) AS started,
                tournament_check_in_window_opened(t) AS opened,
                tournament_has_min_teams(t) AS min_teams
           FROM tournaments t WHERE t.id = $1`,
        [t.id],
      );
      expect(gate.started).toBe(true);
      expect(gate.opened).toBe(false);
      expect(gate.min_teams).toBe(true);

      await postgres.query(
        "SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1",
        [t.id],
      );
      const seeded = await postgres.query<Array<{ seed: number | null }>>(
        "SELECT seed FROM tournament_teams WHERE tournament_id = $1",
        [t.id],
      );
      expect(seeded).toHaveLength(4);
      expect(seeded.every((row) => row.seed !== null)).toBe(true);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      await setStatus(t.id, t.organizer, "Live");

      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(row.status).toBe("Live");
    });

    it("still excludes no-shows once a window really opened", async () => {
      const t = await fullField("3 days");

      await postgres.query(
        `UPDATE tournaments
            SET start = now() + interval '30 minutes',
                check_in_ends_at = now() + interval '10 minutes'
          WHERE id = $1`,
        [t.id],
      );

      const [gate] = await postgres.query<Array<{ min_teams: boolean }>>(
        "SELECT tournament_has_min_teams(t) AS min_teams FROM tournaments t WHERE t.id = $1",
        [t.id],
      );
      expect(gate.min_teams).toBe(false);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      await setStatus(t.id, t.organizer, "Live");

      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(row.status).toBe("CancelledMinTeams");
    });

    // The withdrawal block arrived with check-in but applied to every
    // tournament, and the Hasura delete permission only ever excluded the
    // terminal statuses.
    it("leaves team withdrawal alone on a tournament without check-in", async () => {
      const t = await createTournament();
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const players = await fx.players(2);
      const teamId = await registerTeam(t.id, "Leaver", players);

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      await expect(
        runAsUser(postgres, players[0], "user", (query) =>
          query("DELETE FROM tournament_teams WHERE id = $1", [teamId]),
        ),
      ).resolves.not.toThrow();
    });

    it("blocks the same withdrawal once check-in is required", async () => {
      const t = await createTournament({
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const players = await fx.players(2);
      const teamId = await registerTeam(t.id, "Leaver", players);

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      await expect(
        runAsUser(postgres, players[0], "user", (query) =>
          query("DELETE FROM tournament_teams WHERE id = $1", [teamId]),
        ),
      ).rejects.toThrow(/bracket has been drawn/i);
    });
  });

  // update_tournament_stages sizes the bracket from eligible_at and
  // assign_seeds_to_teams is what writes it, so the seeding has to run first --
  // the other order builds the bracket from a count that still includes every
  // no-show and pads the difference with first-round byes.
  describe("bracket sizing", () => {
    it("builds the bracket for the teams that checked in", async () => {
      const t = await createTournament({
        start: "3 days",
        maxTeams: 8,
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const teams: Array<string> = [];
      for (let i = 1; i <= 8; i++) {
        teams.push(await registerTeam(t.id, `T${i}`, await fx.players(2)));
      }

      await postgres.query(
        `UPDATE tournaments
            SET start = now() + interval '30 minutes',
                check_in_ends_at = now() + interval '10 minutes'
          WHERE id = $1`,
        [t.id],
      );
      await postgres.query(
        "UPDATE tournament_teams SET checked_in_at = now() WHERE id = ANY($1::uuid[])",
        [teams.slice(0, 4)],
      );

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      // Four teams is two first-round matches. Sized for eight it would be four,
      // half of them byes, plus a round nobody plays.
      const [round] = await postgres.query<Array<{ matches: string }>>(
        `SELECT COUNT(*)::text AS matches
           FROM tournament_brackets tb
           JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
          WHERE ts.tournament_id = $1 AND ts."order" = 1 AND tb.round = 1`,
        [t.id],
      );
      expect(Number(round.matches)).toBe(2);
    });
  });

  describe("a draft that creates nothing", () => {
    it("leaves the pool exactly as it found it", async () => {
      const t = await createTournament({
        columns: { registration_type: "free_agents" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const first = await fx.player();
      await registerFreeAgent(
        t.id,
        first,
        new Date(Date.now() - 3_600_000).toISOString(),
      );

      const [empty] = await postgres.query<Array<{ created: number }>>(
        "SELECT draft_tournament_free_agent_teams($1) AS created",
        [t.id],
      );
      expect(empty.created).toBe(0);

      // Waitlisting is one-way without check-in, so burying the earliest
      // signups here hands their slot to whoever registers next.
      const [untouched] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournament_free_agents WHERE tournament_id = $1",
        [t.id],
      );
      expect(untouched.status).toBe("registered");

      await registerFreeAgent(t.id, await fx.player());

      const [drafted] = await postgres.query<Array<{ created: number }>>(
        "SELECT draft_tournament_free_agent_teams($1) AS created",
        [t.id],
      );
      expect(drafted.created).toBe(1);

      const agents = await postgres.query<
        Array<{ player_steam_id: string; status: string }>
      >(
        "SELECT player_steam_id, status FROM tournament_free_agents WHERE tournament_id = $1 ORDER BY created_at",
        [t.id],
      );
      expect(agents.map((agent) => agent.status)).toEqual([
        "drafted",
        "drafted",
      ]);
      expect(agents[0].player_steam_id).toBe(first);
    });
  });

  describe("a free agent who also owns a team", () => {
    it("does not stall the close of registration", async () => {
      const t = await createTournament({
        columns: { registration_type: "both" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      // Pool first, team second: no trigger can catch that order, so the draft
      // is what has to skip them. tournament_teams is
      // UNIQUE (owner_steam_id, tournament_id) and the draft makes its top-rated
      // pick the generated team's owner, so drafting this player raises inside
      // tau_tournaments and rolls the whole transition back -- identically on
      // every retry, with no way out for the organizer.
      const owner = await fx.player();
      await registerFreeAgent(
        t.id,
        owner,
        new Date(Date.now() - 3_600_000).toISOString(),
      );
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Owned', $2, $2)`,
        [t.id, owner],
      );

      for (const agent of await fx.players(2)) {
        await registerFreeAgent(t.id, agent);
      }

      await expect(
        setStatus(t.id, t.organizer, "RegistrationClosed"),
      ).resolves.not.toThrow();

      const [pooled] = await postgres.query<Array<{ status: string }>>(
        `SELECT status FROM tournament_free_agents
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, owner],
      );
      expect(pooled.status).toBe("registered");

      const rostered = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id FROM tournament_team_roster
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, owner],
      );
      expect(rostered).toHaveLength(0);

      const drafted = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1 AND is_drafted",
        [t.id],
      );
      expect(drafted).toHaveLength(1);
    });

    it("refuses the pool join when the team came first", async () => {
      const t = await createTournament({
        columns: { registration_type: "both" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const owner = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Owned', $2, $2)`,
        [t.id, owner],
      );

      await expect(registerFreeAgent(t.id, owner)).rejects.toThrow(
        /already have a team/i,
      );
    });
  });

  // The action and the job carry rules no trigger can enforce (their writes run
  // on a pooled connection with no hasura.user), so they are exercised against
  // the real schema rather than a statement mock.
  describe("check-in action and job on the real schema", () => {
    const notifications = { notifyPlayers: jest.fn() };

    const controller = () =>
      new TournamentsController(
        new Logger("TournamentCheckInActionTest"),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        notifications as never,
        postgres,
        { getConnection: () => ({}) } as never,
      );

    const job = () =>
      new ProcessTournamentCheckIn(
        new Logger("TournamentCheckInJobTest"),
        postgres,
        notifications as never,
      );

    const bracketSlots = (tournamentId: string, teamId: string) =>
      postgres.query<Array<{ id: string }>>(
        `SELECT tb.id FROM tournament_brackets tb
           JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
          WHERE ts.tournament_id = $1
            AND $2::uuid IN (tb.tournament_team_id_1, tb.tournament_team_id_2)`,
        [tournamentId, teamId],
      );

    const status = async (tournamentId: string) => {
      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [tournamentId],
      );
      return row.status;
    };

    // Re-admission is allowed after "continue without them" has already drawn
    // the bracket, and a seed with no slot is a team that shows on the entrant
    // list and never plays.
    it("gives a re-admitted team a bracket slot, not just a seed", async () => {
      const t = await createTournament({
        start: "3 days",
        maxTeams: 4,
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const teams: Array<string> = [];
      for (let i = 1; i <= 4; i++) {
        teams.push(await registerTeam(t.id, `T${i}`, await fx.players(2)));
      }

      await postgres.query(
        `UPDATE tournaments
            SET start = now() + interval '30 minutes',
                check_in_ends_at = now() + interval '10 minutes'
          WHERE id = $1`,
        [t.id],
      );
      await postgres.query(
        `UPDATE tournament_teams SET checked_in_at = now()
          WHERE tournament_id = $1 AND id <> $2`,
        [t.id, teams[3]],
      );

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await bracketSlots(t.id, teams[3])).toHaveLength(0);

      await controller().readmitTournamentTeam({
        user: { name: "Organizer", role: "user", steam_id: t.organizer },
        tournament_id: t.id,
        tournament_team_id: teams[3],
      });

      const [readmitted] = await postgres.query<Array<{ seed: number | null }>>(
        "SELECT seed FROM tournament_teams WHERE id = $1",
        [teams[3]],
      );
      expect(readmitted.seed).not.toBeNull();
      expect((await bracketSlots(t.id, teams[3])).length).toBeGreaterThan(0);
    });

    // A team holding half a lineup is not seedable with or without a
    // confirmation, so it cannot be a no-show -- one abandoned registration
    // would otherwise page the organizer on every check-in tournament.
    const closingField = async (strandedRoster: number) => {
      const t = await createTournament({
        start: "3 days",
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const confirmed = await registerTeam(t.id, "Full", await fx.players(2));
      await registerTeam(t.id, "Partial", await fx.players(strandedRoster));

      await postgres.query(
        `UPDATE tournaments
            SET start = now() + interval '10 minutes',
                check_in_ends_at = now() - interval '1 minute'
          WHERE id = $1`,
        [t.id],
      );
      await postgres.query(
        "UPDATE tournament_teams SET checked_in_at = now() WHERE id = $1",
        [confirmed],
      );

      return t;
    };

    it("does not hold a tournament for a half-finished registration", async () => {
      const t = await closingField(1);

      const [count] = await postgres.query<Array<{ missed: number }>>(
        `SELECT tournament_missed_check_in_count(t) AS missed
           FROM tournaments t WHERE t.id = $1`,
        [t.id],
      );
      expect(count.missed).toBe(0);

      await job().process();

      expect(await status(t.id)).toBe("RegistrationClosed");
    });

    it("still holds a tournament for a team that could have been seeded", async () => {
      const t = await closingField(2);

      const [count] = await postgres.query<Array<{ missed: number }>>(
        `SELECT tournament_missed_check_in_count(t) AS missed
           FROM tournaments t WHERE t.id = $1`,
        [t.id],
      );
      expect(count.missed).toBe(1);

      await job().process();

      expect(await status(t.id)).toBe("CheckInReview");
    });

    // An extension is for the field that is already in. The hold stays -- it is
    // what keeps registration shut to newcomers who would be auto-stamped as
    // checked in on the way past -- and only the deadline moves.
    it("re-opens check-in from the hold without re-opening registration", async () => {
      const t = await closingField(2);
      await job().process();
      expect(await status(t.id)).toBe("CheckInReview");

      await controller().extendTournamentCheckIn({
        user: { name: "Organizer", role: "user", steam_id: t.organizer },
        tournament_id: t.id,
        minutes: 5,
      });

      expect(await status(t.id)).toBe("CheckInReview");

      const [window] = await postgres.query<Array<{ open: boolean }>>(
        `SELECT tournament_check_in_open(t) AS open
           FROM tournaments t WHERE t.id = $1`,
        [t.id],
      );
      expect(window.open).toBe(true);

      // The pass has to leave the live extension alone and come back for its
      // deadline -- once. Keyed on the deadline it closed rather than on the
      // status, which cannot tell an extension apart from the hold it runs in.
      await job().process();
      expect(await status(t.id)).toBe("CheckInReview");

      await postgres.query(
        "UPDATE tournaments SET check_in_ends_at = now() - interval '1 minute' WHERE id = $1",
        [t.id],
      );
      notifications.notifyPlayers.mockClear();

      await job().process();
      expect(await status(t.id)).toBe("CheckInReview");
      expect(notifications.notifyPlayers).toHaveBeenCalledTimes(1);

      notifications.notifyPlayers.mockClear();
      await job().process();
      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    // The whole point of extending: the team that shows up in the extra minutes
    // is seeded, and the tournament closes on its own.
    it("closes into RegistrationClosed once the missing team confirms", async () => {
      const t = await closingField(2);
      await job().process();

      await controller().extendTournamentCheckIn({
        user: { name: "Organizer", role: "user", steam_id: t.organizer },
        tournament_id: t.id,
        minutes: 5,
      });

      await postgres.query(
        "UPDATE tournament_teams SET checked_in_at = now() WHERE tournament_id = $1",
        [t.id],
      );
      await postgres.query(
        "UPDATE tournaments SET check_in_ends_at = now() - interval '1 minute' WHERE id = $1",
        [t.id],
      );

      await job().process();
      expect(await status(t.id)).toBe("RegistrationClosed");
    });
  });
});
