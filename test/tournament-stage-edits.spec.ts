import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Every structural stage edit rebuilds the whole tournament's brackets, which
// deletes every match in it. Once the bracket is drawn that has to be refused,
// while format-only tweaks, edits after a reset to Setup and the whole-
// tournament delete keep working.
describe("tournament stage edits after the draw (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentStageEditsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199870000000n);
    tfx = new TournamentFixtures(postgres, fx);
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

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
  ];

  const GROUP_THEN_FINAL = [
    { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 },
    { type: "SingleElimination", order: 2, minTeams: 2, maxTeams: 2 },
  ];

  const tournamentMatches = (tournamentId: string) =>
    postgres.query<Array<{ id: string; status: string }>>(
      `SELECT m.id, m.status
         FROM matches m
         JOIN tournament_brackets tb ON tb.match_id = m.id
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = $1
        ORDER BY m.id`,
      [tournamentId],
    );

  const existingMatches = async (matchIds: Array<string>) =>
    (
      await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM matches WHERE id = ANY($1::uuid[]) ORDER BY id",
        [matchIds],
      )
    ).map((match) => match.id);

  // Settles the edit first so a run that wipes the matches reports that,
  // not just the missing refusal.
  const attempt = async (
    sql: string,
    params: Array<string>,
  ): Promise<Error | null> => {
    try {
      await postgres.query(sql, params);
      return null;
    } catch (error) {
      return error as Error;
    }
  };

  const pausedWithFinishedMatch = async () => {
    const t = await tfx.launch(GROUP_THEN_FINAL, 4);
    const [first] = (await tfx.getBrackets(t.stageIds[0])).filter(
      (b) => b.round === 1 && b.match_id,
    );
    await tfx.winMatch(first.match_id!);
    await tfx.setStatus(t.id, t.organizer, "Paused");

    const matches = await tournamentMatches(t.id);
    expect(matches.find((match) => match.id === first.match_id)?.status).toBe(
      "Finished",
    );
    expect(await tfx.tournamentStatus(t.id)).toBe("Paused");

    return { ...t, matchIds: matches.map((match) => match.id).sort() };
  };

  const drawnRegistrationClosed = async () => {
    const t = await tfx.createTournament(GROUP_THEN_FINAL);
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");

    const matches = await tournamentMatches(t.id);
    expect(matches.length).toBe(2);

    return { ...t, matchIds: matches.map((match) => match.id).sort() };
  };

  describe("a paused tournament with a finished match", () => {
    it("refuses a stage delete and keeps every match", async () => {
      const t = await pausedWithFinishedMatch();

      const error = await attempt(
        "DELETE FROM tournament_stages WHERE id = $1",
        [t.stageIds[1]],
      );

      expect(await existingMatches(t.matchIds)).toEqual(t.matchIds);
      expect(error?.message).toMatch(/registration has closed/);
    });

    it("refuses a new stage and keeps every match", async () => {
      const t = await pausedWithFinishedMatch();

      const error = await attempt(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 3, 2, 2)`,
        [t.id],
      );

      expect(await existingMatches(t.matchIds)).toEqual(t.matchIds);
      expect(error?.message).toMatch(/registration has closed/);
    });

    it("refuses a structural stage update and keeps every match", async () => {
      const t = await pausedWithFinishedMatch();

      const error = await attempt(
        "UPDATE tournament_stages SET max_rounds = 2 WHERE id = $1",
        [t.stageIds[0]],
      );

      expect(await existingMatches(t.matchIds)).toEqual(t.matchIds);
      expect(error?.message).toMatch(/registration has closed/);
    });

    it("still takes a format-only change", async () => {
      const t = await pausedWithFinishedMatch();

      await postgres.query(
        "UPDATE tournament_stages SET default_best_of = 3 WHERE id = $1",
        [t.stageIds[1]],
      );

      expect(await existingMatches(t.matchIds)).toEqual(t.matchIds);
    });

    // The same order deleteTournament uses: matches first, then the tournament.
    it("can still be deleted whole", async () => {
      const t = await pausedWithFinishedMatch();

      await postgres.query("DELETE FROM matches WHERE id = ANY($1::uuid[])", [
        t.matchIds,
      ]);
      await postgres.query("DELETE FROM tournaments WHERE id = $1", [t.id]);

      const stages = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_stages WHERE tournament_id = $1",
        [t.id],
      );
      expect(stages).toEqual([]);
    });
  });

  describe("registration closed with round 1 drawn", () => {
    it("refuses a stage delete and keeps round 1", async () => {
      const t = await drawnRegistrationClosed();

      const error = await attempt(
        "DELETE FROM tournament_stages WHERE id = $1",
        [t.stageIds[1]],
      );

      expect(await existingMatches(t.matchIds)).toEqual(t.matchIds);
      expect(error?.message).toMatch(/registration has closed/);
    });

    it("refuses a structural stage update and keeps round 1", async () => {
      const t = await drawnRegistrationClosed();

      const error = await attempt(
        "UPDATE tournament_stages SET third_place_match = true WHERE id = $1",
        [t.stageIds[1]],
      );

      expect(await existingMatches(t.matchIds)).toEqual(t.matchIds);
      expect(error?.message).toMatch(/registration has closed/);
    });
  });

  describe("before the draw", () => {
    it("adds a stage while registration is open", async () => {
      const t = await tfx.createTournament([
        { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
      ]);
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      for (let i = 0; i < 4; i++) {
        await tfx.registerTeam(t.id, await fx.team(1));
      }

      await postgres.query(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 2, 4, 4)`,
        [t.id],
      );

      const stages = await postgres.query<Array<{ order: number }>>(
        `SELECT "order" FROM tournament_stages WHERE tournament_id = $1 ORDER BY "order"`,
        [t.id],
      );
      expect(stages.map((stage) => Number(stage.order))).toEqual([1, 2]);
    });

    it("refuses a stage edit once the open registration's bracket has teams", async () => {
      const t = await tfx.createTournament(SE4);
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      for (let i = 0; i < 4; i++) {
        await tfx.registerTeam(t.id, await fx.team(1));
      }
      await postgres.query(
        "SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1",
        [t.id],
      );
      await postgres.query("SELECT seed_stage($1)", [t.stageIds[0]]);

      await expect(
        postgres.query(
          "UPDATE tournament_stages SET max_teams = 8 WHERE id = $1",
          [t.stageIds[0]],
        ),
      ).rejects.toThrow(/bracket has been drawn/);
    });

    it("edits stages again once a cancelled tournament is reset to Setup", async () => {
      const t = await tfx.launch(SE4, 4);
      await tfx.setStatus(t.id, t.organizer, "Cancelled");
      await tfx.setStatus(t.id, t.organizer, "Setup");

      await postgres.query(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 2, 2, 2)`,
        [t.id],
      );
      await postgres.query("DELETE FROM tournament_stages WHERE id = $1", [
        t.stageIds[0],
      ]);

      const stages = await postgres.query<Array<{ order: number }>>(
        `SELECT "order" FROM tournament_stages WHERE tournament_id = $1 ORDER BY "order"`,
        [t.id],
      );
      expect(stages.map((stage) => Number(stage.order))).toEqual([1]);
    });
  });
});
