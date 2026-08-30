import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Round 1 is materialized while the tournament is still RegistrationClosed (or
// held in CheckInReview) so the draw is visible -- which also handed every team
// a joinable, vetoable, startable match hours before the tournament began, and
// gave it a no-show deadline derived from the moment the bracket was drawn.
describe("tournament matches before the tournament starts (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentPreStartTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561198100000000n);
    await fx.region("TestPS");
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
    start = "2 hours",
    autoStart = true,
    columns = {} as Record<string, string | number | boolean>,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestPS}', 0
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );

    const names = Object.keys(columns);
    const extraCols = names.map((name) => `, "${name}"`).join("");
    const extraVals = names.map((_, i) => `, $${i + 6}`).join("");

    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, auto_start${extraCols})
       VALUES ($1, now() + $2::interval, $3, $4, 'Setup', $5${extraVals}) RETURNING id`,
      [
        fx.nextName("cup"),
        start,
        organizer,
        options.id,
        autoStart,
        ...names.map((name) => columns[name]),
      ],
    );

    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 4)`,
      [tournament.id],
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

  const registerTeam = async (tournamentId: string, name: string) => {
    const players = await fx.players(2);
    const [team] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [tournamentId, name, players[0]],
    );

    for (const player of players) {
      await runAsUser(postgres, player, "admin", (query) =>
        query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1, $2, $3)`,
          [team.id, player, tournamentId],
        ),
      );
    }

    return team.id;
  };

  type TournamentMatch = {
    id: string;
    status: string;
    scheduled_at: Date | null;
    cancels_at: Date | null;
    start: Date;
  };

  const tournamentMatches = (tournamentId: string) =>
    postgres.query<Array<TournamentMatch>>(
      `SELECT m.id, m.status, m.scheduled_at, m.cancels_at, t."start"
         FROM matches m
         INNER JOIN tournament_brackets tb ON tb.match_id = m.id
         INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         INNER JOIN tournaments t ON t.id = ts.tournament_id
        WHERE ts.tournament_id = $1
        ORDER BY tb.round, tb.match_number`,
      [tournamentId],
    );

  const matchStatus = async (matchId: string) => {
    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM matches WHERE id = $1",
      [matchId],
    );
    return row.status;
  };

  // Registration through the seeded bracket with four full teams.
  const closedCup = async (
    options: Parameters<typeof createTournament>[0] = {},
  ) => {
    const t = await createTournament(options);
    await setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 1; i <= 4; i++) {
      await registerTeam(t.id, `T${i}`);
    }
    await setStatus(t.id, t.organizer, "RegistrationClosed");
    return t;
  };

  describe("materialized early", () => {
    it("parks the round it drew without hiding the draw", async () => {
      const t = await closedCup();

      const matches = await tournamentMatches(t.id);
      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.status)).toEqual([
        "Scheduled",
        "Scheduled",
      ]);
      // Nothing is counting down yet either -- the auto-cancel timer belongs to
      // the check-in window, and the window has not opened.
      expect(matches.every((match) => match.cancels_at === null)).toBe(true);

      // The whole point of drawing early: the bracket, the seeds and the
      // opponents are published, they are just not playable.
      const brackets = await postgres.query<
        Array<{ tournament_team_id_1: string | null; match_id: string | null }>
      >(
        `SELECT tb.tournament_team_id_1, tb.match_id
           FROM tournament_brackets tb
           INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
          WHERE ts.tournament_id = $1 AND tb.round = 1`,
        [t.id],
      );
      expect(brackets).toHaveLength(2);
      expect(
        brackets.every(
          (bracket) =>
            bracket.tournament_team_id_1 !== null && bracket.match_id !== null,
        ),
      ).toBe(true);
    });

    it("takes its no-show deadline from the tournament start, not the draw", async () => {
      const t = await closedCup();

      const [match] = await tournamentMatches(t.id);
      // GREATEST(..., now()) keeps a running tournament on its current timing,
      // so this is an exact match rather than an approximation.
      expect(match.scheduled_at).toEqual(match.start);

      await setStatus(t.id, t.organizer, "Live");

      const [released] = await tournamentMatches(t.id);
      expect(released.cancels_at).not.toBeNull();
      expect(released.cancels_at!.getTime()).toBeGreaterThan(
        match.start.getTime(),
      );
    });
  });

  describe("the gate refuses every route", () => {
    it("refuses the scheduler, an organizer and a raw write alike", async () => {
      const t = await closedCup();
      const [match] = await tournamentMatches(t.id);

      for (const status of [
        "WaitingForCheckIn",
        "Veto",
        "WaitingForServer",
        "Live",
      ]) {
        await postgres.query("UPDATE matches SET status = $1 WHERE id = $2", [
          status,
          match.id,
        ]);
        expect(await matchStatus(match.id)).toBe("Scheduled");
      }

      await runAsUser(postgres, t.organizer, "admin", (query) =>
        query("UPDATE matches SET status = 'Live' WHERE id = $1", [match.id]),
      );
      expect(await matchStatus(match.id)).toBe("Scheduled");
    });

    // Only the playable ladder is gated. A gate that swallowed the terminal
    // statuses too would leave cancellation, the tournament reset and match
    // deletion with no way out of 'Scheduled'.
    it("leaves cancellation and deletion alone", async () => {
      const t = await closedCup();
      const [first, second] = await tournamentMatches(t.id);
      expect(first.status).toBe("Scheduled");

      await postgres.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        [first.id],
      );
      expect(await matchStatus(first.id)).toBe("Canceled");

      await postgres.query("DELETE FROM matches WHERE id = $1", [second.id]);
      const remaining = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM matches WHERE id = $1",
        [second.id],
      );
      expect(remaining).toHaveLength(0);
    });
  });

  describe("release", () => {
    it("releases the parked round the moment the tournament goes live", async () => {
      const t = await closedCup();
      const parked = await tournamentMatches(t.id);
      expect(parked.map((match) => match.status)).toEqual([
        "Scheduled",
        "Scheduled",
      ]);

      await setStatus(t.id, t.organizer, "Live");

      const released = await tournamentMatches(t.id);
      expect(released.map((match) => match.status)).toEqual([
        "WaitingForCheckIn",
        "WaitingForCheckIn",
      ]);
    });

    // A league fixture or an admin-mode bracket carries its own kickoff. Going
    // live must not drag the whole season onto the same minute.
    it("leaves a bracket with its own far-later schedule parked", async () => {
      const t = await createTournament({ autoStart: false });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      for (let i = 1; i <= 4; i++) {
        await registerTeam(t.id, `T${i}`);
      }
      await setStatus(t.id, t.organizer, "RegistrationClosed");

      // auto_start is off, so the bracket exists with no match yet and the
      // organizer's own schedule can be written before it is materialized.
      await postgres.query(
        `UPDATE tournament_brackets tb
            SET scheduled_at = now() + interval '3 days'
           FROM tournament_stages ts
          WHERE ts.id = tb.tournament_stage_id
            AND ts.tournament_id = $1
            AND tb.round = 1`,
        [t.id],
      );
      await postgres.query(
        `SELECT schedule_tournament_match(tb)
           FROM tournament_brackets tb
           INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
          WHERE ts.tournament_id = $1 AND tb.round = 1`,
        [t.id],
      );

      const parked = await tournamentMatches(t.id);
      expect(parked).toHaveLength(2);
      expect(parked.every((match) => match.status === "Scheduled")).toBe(true);

      await setStatus(t.id, t.organizer, "Live");

      const after = await tournamentMatches(t.id);
      expect(after.every((match) => match.status === "Scheduled")).toBe(true);
    });

    it("never gates a tournament that is already running", async () => {
      const t = await closedCup();
      await setStatus(t.id, t.organizer, "Live");

      const [match] = await tournamentMatches(t.id);
      const [gate] = await postgres.query<Array<{ pre_start: boolean }>>(
        "SELECT tournament_match_is_pre_start($1) AS pre_start",
        [match.id],
      );
      expect(gate.pre_start).toBe(false);

      await postgres.query("UPDATE matches SET status = 'Veto' WHERE id = $1", [
        match.id,
      ]);
      expect(await matchStatus(match.id)).toBe("Veto");
    });
  });

  // A tournament held for organizer review has registration behind it and its
  // start ahead of it, and re-admitting a team re-runs the seeding -- which
  // materializes round 1 while the organizer is still deciding.
  describe("held in CheckInReview", () => {
    it("parks a round drawn while the organizer is still deciding", async () => {
      const t = await createTournament({
        start: "2 hours",
        columns: { check_in_required: true },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      for (let i = 1; i <= 4; i++) {
        await registerTeam(t.id, `T${i}`);
      }
      await setStatus(t.id, t.organizer, "CheckInReview");

      // Exactly what readmitTournamentTeam runs.
      await postgres.query(
        "SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1",
        [t.id],
      );
      await postgres.query("SELECT update_tournament_stages($1)", [t.id]);
      await postgres.query(
        `SELECT seed_stage(ts.id) FROM tournament_stages ts
          WHERE ts.tournament_id = $1 AND ts."order" = 1`,
        [t.id],
      );

      const matches = await tournamentMatches(t.id);
      expect(matches).toHaveLength(2);
      expect(matches.every((match) => match.status === "Scheduled")).toBe(true);
    });
  });
});
