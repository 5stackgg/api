import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tournament_current_stage: the stage order the tournament page and cards
// land on, walked through a real two-stage playout.
describe("tournament current stage (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  const TWO_STAGES = [
    { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 },
    { type: "SingleElimination", order: 2, minTeams: 2, maxTeams: 2 },
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentCurrentStageTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199310000000n);
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

  async function currentStage(tournamentId: string): Promise<number | null> {
    const [row] = await postgres.query<Array<{ stage: number | null }>>(
      `SELECT public.tournament_current_stage(t) AS stage
       FROM tournaments t WHERE t.id = $1`,
      [tournamentId],
    );
    return row.stage;
  }

  it("is null for a tournament with no stages", async () => {
    const t = await tfx.createTournament([]);

    expect(await currentStage(t.id)).toBeNull();
  });

  it("is the first stage before any team is seeded", async () => {
    const t = await tfx.createTournament(TWO_STAGES);

    expect(await currentStage(t.id)).toBe(1);
  });

  it("stays on stage 1 while it still has matches to play", async () => {
    const t = await tfx.launch(TWO_STAGES, 4);
    expect(await currentStage(t.id)).toBe(1);

    await tfx.playRound(t.stageIds[0], 1);

    expect(await currentStage(t.id)).toBe(1);
  });

  it("moves to stage 2 once stage 1 is finished", async () => {
    const t = await tfx.launch(TWO_STAGES, 4);

    await tfx.playStage(t.stageIds[0]);

    expect(await tfx.tournamentStatus(t.id)).toBe("Live");
    const [final] = await tfx.getBrackets(t.stageIds[1]);
    expect(final.tournament_team_id_1).not.toBeNull();
    expect(final.tournament_team_id_2).not.toBeNull();
    expect(final.finished).toBe(false);
    expect(await currentStage(t.id)).toBe(2);
  });

  it("holds on stage 1 while any of its matches is still open", async () => {
    const t = await tfx.launch(TWO_STAGES, 4);
    await tfx.playStage(t.stageIds[0]);

    const [reopened] = await tfx.getBrackets(t.stageIds[0]);
    await postgres.query(
      "UPDATE tournament_brackets SET finished = false WHERE id = $1",
      [reopened.id],
    );

    expect(await currentStage(t.id)).toBe(1);
  });

  it("ignores byes and teamless brackets left open in an earlier stage", async () => {
    const t = await tfx.launch(TWO_STAGES, 4);
    await tfx.playStage(t.stageIds[0]);

    const [bye] = await tfx.getBrackets(t.stageIds[0]);
    await postgres.query(
      "UPDATE tournament_brackets SET bye = true, finished = false WHERE id = $1",
      [bye.id],
    );
    await postgres.query(
      `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number)
       VALUES ($1, 99, 1)`,
      [t.stageIds[0]],
    );

    expect(await currentStage(t.id)).toBe(2);
  });

  it("lands on the final stage once the tournament is finished", async () => {
    const t = await tfx.launch(TWO_STAGES, 4);

    await tfx.playStage(t.stageIds[0]);
    await tfx.playStage(t.stageIds[1]);

    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    expect(await currentStage(t.id)).toBe(2);
  });
});
