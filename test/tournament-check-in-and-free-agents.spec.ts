import { PostgresService } from "./../src/postgres/postgres.service";
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

    it("rolls per-player confirmations up into the team in Players mode", async () => {
      const t = await createTournament({
        start: "30 minutes",
        columns: { check_in_required: true, check_in_setting: "Players" },
      });
      await postgres.query(
        "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
        [t.id],
      );

      const owner = await fx.player();
      const mate = await fx.player();
      const [team] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id, checked_in_at)
         VALUES ($1, 'Roster', $2, $2, NULL) RETURNING id`,
        [t.id, owner],
      );
      for (const player of [owner, mate]) {
        await runAsUser(postgres, player, "admin", (query) =>
          query(
            `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [team.id, player, t.id],
          ),
        );
      }

      const teamCheckedIn = async () => {
        const [row] = await postgres.query<
          Array<{ checked_in_at: Date | null }>
        >("SELECT checked_in_at FROM tournament_teams WHERE id = $1", [
          team.id,
        ]);
        return row.checked_in_at !== null;
      };

      // Wingman fields two, so one confirmation is not enough.
      await postgres.query(
        "UPDATE tournament_team_roster SET checked_in_at = now() WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [team.id, owner],
      );
      expect(await teamCheckedIn()).toBe(false);

      await postgres.query(
        "UPDATE tournament_team_roster SET checked_in_at = now() WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [team.id, mate],
      );
      expect(await teamCheckedIn()).toBe(true);
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

      const showed = await fx.player();
      const mate = await fx.player();
      const noShow = await fx.player();
      const noShowMate = await fx.player();

      const [teamA] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'A', $2, $2) RETURNING id`,
        [t.id, showed],
      );
      const [teamB] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'B', $2, $2) RETURNING id`,
        [t.id, noShow],
      );
      for (const [team, players] of [
        [teamA.id, [showed, mate]],
        [teamB.id, [noShow, noShowMate]],
      ] as Array<[string, Array<string>]>) {
        for (const player of players) {
          // tbi_tournament_team_roster reads hasura.user unconditionally, so a
          // roster insert has to arrive with a session like a real request.
          await runAsUser(postgres, player, "admin", (query) =>
            query(
              `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [team, player, t.id],
            ),
          );
        }
      }

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

    it("allows the extend path back to RegistrationOpen", async () => {
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
});
