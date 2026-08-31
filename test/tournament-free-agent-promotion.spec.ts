import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Waitlisting used to be a one-way door: a drafted free agent who left took
// their pickup team below the minimum lineup, the team was dropped at seeding,
// and the waitlist behind them never moved.
describe("free agent waitlist promotion (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentFreeAgentPromotionTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561198200000000n);
    await fx.region("TestFA");
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
    start = "3 days",
    maxTeams = 4,
    // A stage refuses fewer than four teams per group, so four is the floor for
    // every pool in this suite.
    minTeams = 4,
    columns = {} as Record<string, string | number | boolean>,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestFA}', 0
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );

    const names = Object.keys(columns);
    const extraCols = names.map((name) => `, "${name}"`).join("");
    const extraVals = names.map((_, i) => `, $${i + 5}`).join("");

    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, registration_type${extraCols})
       VALUES ($1, now() + $2::interval, $3, $4, 'Setup', 'free_agents'${extraVals}) RETURNING id`,
      [
        fx.nextName("pool"),
        start,
        organizer,
        options.id,
        ...names.map((name) => columns[name]),
      ],
    );

    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, $2, $3)`,
      [tournament.id, minTeams, maxTeams],
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
    createdAt: string,
  ) =>
    postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id, created_at)
       VALUES ($1, $2, $3::timestamptz)`,
      [tournamentId, steamId, createdAt],
    );

  // A drafted pool: `agents` signups a minute apart, drafted into pickup teams
  // of two. Whoever is past the cut is waitlisted, oldest signup first.
  const draftedPool = async ({
    agents = 10,
    maxTeams = 4,
    minTeams = 4,
    columns = {} as Record<string, string | number | boolean>,
    signupOrder,
  }: {
    agents?: number;
    maxTeams?: number;
    minTeams?: number;
    columns?: Record<string, string | number | boolean>;
    signupOrder?: Array<number>;
  } = {}) => {
    const t = await createTournament({ maxTeams, minTeams, columns });
    await setStatus(t.id, t.organizer, "RegistrationOpen");

    const players: Array<string> = [];
    for (let i = 0; i < agents; i++) {
      players.push(await fx.player());
    }

    // created_at is what decides, so the insert order is deliberately allowed to
    // differ from it.
    const order = signupOrder ?? players.map((_, index) => index);
    const base = Date.now() - agents * 60_000;
    for (const index of order) {
      await registerFreeAgent(
        t.id,
        players[index],
        new Date(base + index * 60_000).toISOString(),
      );
    }

    await postgres.query("SELECT draft_tournament_free_agent_teams($1)", [
      t.id,
    ]);

    return { ...t, players };
  };

  type Agent = {
    player_steam_id: string;
    status: string;
    tournament_team_id: string | null;
  };

  const agents = (tournamentId: string) =>
    postgres.query<Array<Agent>>(
      `SELECT player_steam_id, status, tournament_team_id
         FROM tournament_free_agents
        WHERE tournament_id = $1
        ORDER BY created_at, id`,
      [tournamentId],
    );

  const roster = (teamId: string) =>
    postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id FROM tournament_team_roster
        WHERE tournament_team_id = $1 ORDER BY player_steam_id`,
      [teamId],
    );

  const teamOf = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ tournament_team_id: string }>>(
      `SELECT tournament_team_id FROM tournament_team_roster
        WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId],
    );
    return row?.tournament_team_id ?? null;
  };

  const removeFromRoster = (tournamentId: string, steamId: string) =>
    postgres.query(
      `DELETE FROM tournament_team_roster
        WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId],
    );

  // The draft's ELO snake decides which generated team a selected player lands
  // on, so nothing about the pool order says who shares a team with whom. One
  // player per team, read back from the roster.
  const onePerTeam = (tournamentId: string) =>
    postgres.query<
      Array<{ player_steam_id: string; tournament_team_id: string }>
    >(
      `SELECT DISTINCT ON (ttr.tournament_team_id)
              ttr.player_steam_id, ttr.tournament_team_id
         FROM tournament_team_roster ttr
        WHERE ttr.tournament_id = $1
        ORDER BY ttr.tournament_team_id, ttr.player_steam_id`,
      [tournamentId],
    );

  describe("a drafted slot opening up", () => {
    it("hands it to the earliest-registered waitlisted agent", async () => {
      const t = await draftedPool();
      const leaver = t.players[0];
      const team = await teamOf(t.id, leaver);
      expect(team).not.toBeNull();

      await removeFromRoster(t.id, leaver);

      // players[8] signed up before players[9]; the team is whole again.
      const filled = await roster(team!);
      expect(filled).toHaveLength(2);
      expect(filled.map((row) => row.player_steam_id)).toContain(t.players[8]);

      const pool = await agents(t.id);
      const promoted = pool.find(
        (agent) => agent.player_steam_id === t.players[8],
      );
      expect(promoted!.status).toBe("drafted");
      expect(promoted!.tournament_team_id).toBe(team);

      // The one who left is out of the pool rather than left pointing at a team
      // they are no longer on.
      const departed = pool.find((agent) => agent.player_steam_id === leaver);
      expect(departed!.status).toBe("withdrawn");
      expect(departed!.tournament_team_id).toBeNull();

      // The one behind them keeps waiting, in order.
      const waiting = pool.find(
        (agent) => agent.player_steam_id === t.players[9],
      );
      expect(waiting!.status).toBe("waitlisted");
    });

    // Sign-up order is the whole promise of a first-come pool; the row that
    // happened to be INSERTED first is not the one that signed up first.
    it("goes by sign-up time, not by the order the rows were written", async () => {
      const t = await draftedPool({
        // players[9] (the later signup) is written to the pool before
        // players[8] (the earlier one).
        signupOrder: [0, 1, 2, 3, 4, 5, 6, 7, 9, 8],
      });

      const team = await teamOf(t.id, t.players[0]);
      await removeFromRoster(t.id, t.players[0]);

      expect(await teamOf(t.id, t.players[8])).toBe(team);
      expect(await teamOf(t.id, t.players[9])).toBeNull();
    });

    it("does nothing when the team is already whole", async () => {
      const t = await draftedPool();
      const team = await teamOf(t.id, t.players[0]);

      const [attempt] = await postgres.query<
        Array<{ promoted: string | null }>
      >("SELECT promote_tournament_free_agent($1, $2) AS promoted", [
        t.id,
        team,
      ]);
      expect(attempt.promoted).toBeNull();

      const pool = await agents(t.id);
      expect(
        pool.filter((agent) => agent.status === "waitlisted"),
      ).toHaveLength(2);
    });
  });

  describe("who is skipped", () => {
    it("skips a waitlisted agent already on a roster in this tournament", async () => {
      const t = await draftedPool();

      // A separate team picked them up directly; the roster key is unique per
      // (tournament, player), so drafting them again would abort the caller's
      // whole statement.
      const outsider = await fx.player();
      const [other] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Outsiders', $2, $2) RETURNING id`,
        [t.id, outsider],
      );
      await runAsUser(postgres, t.organizer, "admin", (query) =>
        query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1, $2, $3)`,
          [other.id, t.players[8], t.id],
        ),
      );

      const team = await teamOf(t.id, t.players[0]);
      await removeFromRoster(t.id, t.players[0]);

      expect(await teamOf(t.id, t.players[9])).toBe(team);
    });

    // tournament_teams is UNIQUE (owner_steam_id, tournament_id) and every
    // pickup team takes one of its own players as owner -- the collision that
    // hard-stalled the draft once already.
    it("skips a waitlisted agent who owns a team in this tournament", async () => {
      const t = await draftedPool();

      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Owned', $2, $2)`,
        [t.id, t.players[8]],
      );

      const team = await teamOf(t.id, t.players[0]);
      await removeFromRoster(t.id, t.players[0]);

      expect(await teamOf(t.id, t.players[9])).toBe(team);
      expect(await teamOf(t.id, t.players[8])).toBeNull();
    });

    it("skips a waitlisted agent who no longer meets the entry requirements", async () => {
      const t = await draftedPool();

      await postgres.query(
        "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
        [t.players[9]],
      );
      await postgres.query(
        "UPDATE tournaments SET min_role = 'verified_user' WHERE id = $1",
        [t.id],
      );

      const team = await teamOf(t.id, t.players[0]);
      await removeFromRoster(t.id, t.players[0]);

      expect(await teamOf(t.id, t.players[8])).toBeNull();
      expect(await teamOf(t.id, t.players[9])).toBe(team);
    });

    // The close pass waitlists every free agent who missed the prompt, so after
    // the window shuts the waitlist is a mix of "passed over" and "never showed
    // up". Promoting the second kind puts a player who is not there into a game.
    it("never promotes a no-show once the check-in window has closed", async () => {
      const t = await draftedPool({ columns: { check_in_required: true } });

      // One statement: the schedule freeze is evaluated against OLD, which has
      // not started check-in yet.
      await postgres.query(
        `UPDATE tournaments
            SET start = now() + interval '20 minutes',
                check_in_ends_at = now() - interval '1 minute'
          WHERE id = $1`,
        [t.id],
      );
      await postgres.query(
        `UPDATE tournament_free_agents SET checked_in_at = now()
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, t.players[9]],
      );

      const team = await teamOf(t.id, t.players[0]);
      await removeFromRoster(t.id, t.players[0]);

      expect(await teamOf(t.id, t.players[8])).toBeNull();
      expect(await teamOf(t.id, t.players[9])).toBe(team);
    });

    it("stops once the bracket is in play", async () => {
      // Six teams, so the field still clears the four-team floor with one of
      // them left short.
      const t = await draftedPool({ agents: 14, maxTeams: 6 });
      const [a, b] = await onePerTeam(t.id);
      const shortA = a.tournament_team_id;
      const shortB = b.tournament_team_id;

      // Emptied first so these two removals leave real vacancies, then put back.
      const waiting = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM tournament_free_agents
          WHERE tournament_id = $1 AND status = 'waitlisted'`,
        [t.id],
      );
      const waitingIds = waiting.map((row) => row.id);
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'withdrawn' WHERE id = ANY($1::uuid[])",
        [waitingIds],
      );
      await removeFromRoster(t.id, a.player_steam_id);
      await removeFromRoster(t.id, b.player_steam_id);
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'waitlisted' WHERE id = ANY($1::uuid[])",
        [waitingIds],
      );

      const [before] = await postgres.query<Array<{ promoted: string | null }>>(
        "SELECT promote_tournament_free_agent($1, $2) AS promoted",
        [t.id, shortA],
      );
      expect(before.promoted).not.toBeNull();

      await setStatus(t.id, t.organizer, "Live");

      const [after] = await postgres.query<Array<{ promoted: string | null }>>(
        "SELECT promote_tournament_free_agent($1, $2) AS promoted",
        [t.id, shortB],
      );
      expect(after.promoted).toBeNull();
    });
  });

  describe("more than one departure", () => {
    it("gives each vacancy a different player", async () => {
      const t = await draftedPool();
      const team = (await teamOf(t.id, t.players[0]))!;
      const original = await roster(team);

      for (const row of original) {
        await removeFromRoster(t.id, row.player_steam_id);
      }

      // Both waitlisted agents landed, in sign-up order, and neither was
      // promoted twice.
      expect(await roster(team)).toEqual([
        { player_steam_id: t.players[8] },
        { player_steam_id: t.players[9] },
      ]);
    });

    // Two departures landing at once must not both read the waitlist before
    // either writes to it: the second promotion would collide on the roster's
    // unique key and roll a legitimate departure back.
    it("survives two departures arriving together", async () => {
      const t = await draftedPool();
      const [a, b] = await onePerTeam(t.id);

      await Promise.all(
        [a, b].map((leaver) =>
          runAsUser(postgres, t.organizer, "admin", (query) =>
            query(
              `DELETE FROM tournament_team_roster
                WHERE tournament_id = $1 AND player_steam_id = $2`,
              [t.id, leaver.player_steam_id],
            ),
          ),
        ),
      );

      const promoted = [
        await teamOf(t.id, t.players[8]),
        await teamOf(t.id, t.players[9]),
      ];
      expect(promoted).toContain(a.tournament_team_id);
      expect(promoted).toContain(b.tournament_team_id);
    });
  });

  describe("leaveTournamentAsFreeAgent", () => {
    const controller = () =>
      new TournamentsController(
        new Logger("FreeAgentPromotionActionTest"),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { notifyPlayers: jest.fn() } as never,
        postgres,
        { getConnection: () => ({}) } as never,
      );

    it("gives the slot up and re-seeds the team that was filled", async () => {
      const t = await draftedPool();
      const leaver = t.players[0];
      const team = await teamOf(t.id, leaver);

      await controller().leaveTournamentAsFreeAgent({
        user: { steam_id: leaver, role: "user" } as never,
        tournament_id: t.id,
      });

      // The roster row goes with the pool row -- otherwise the team looks whole
      // and nothing is ever promoted.
      expect(await teamOf(t.id, leaver)).toBeNull();
      expect(await teamOf(t.id, t.players[8])).toBe(team);

      // check_team_eligibility restores eligible_at on the roster write but
      // never gives the seed back; only the re-seed does.
      const [seeded] = await postgres.query<
        Array<{ seed: number | null; eligible_at: Date | null }>
      >("SELECT seed, eligible_at FROM tournament_teams WHERE id = $1", [team]);
      expect(seeded.eligible_at).not.toBeNull();
      expect(seeded.seed).not.toBeNull();

      // The same action from someone who was never drafted stays a plain
      // withdrawal: nothing to give up, nobody to promote.
      const other = await draftedPool();
      await controller().leaveTournamentAsFreeAgent({
        user: { steam_id: other.players[9], role: "user" } as never,
        tournament_id: other.id,
      });

      const pool = await agents(other.id);
      expect(pool).toHaveLength(9);
      expect(pool.filter((agent) => agent.status === "drafted")).toHaveLength(
        8,
      );
      expect(
        pool.filter((agent) => agent.status === "waitlisted"),
      ).toHaveLength(1);
    });
  });
});
