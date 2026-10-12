import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tournament_brackets.match_id is ON DELETE SET NULL, so a hard-deleted
// tournament match leaves its bracket slot behind with no match to reset.
// recreate_tournament_bracket_match puts a match back through the normal
// scheduling path and, for a slot that had been won, unwinds what it fed.
describe("recreating an orphaned tournament bracket match (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentBracketMatchRecreateTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199880000000n);
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

  const recreate = async (bracketId: string): Promise<string> => {
    const [row] = await postgres.query<Array<{ match_id: string }>>(
      "SELECT recreate_tournament_bracket_match($1) AS match_id",
      [bracketId],
    );
    return row.match_id;
  };

  const bracket = async (id: string) => {
    const [row] = await postgres.query<
      Array<{
        match_id: string | null;
        finished: boolean;
        tournament_team_id_1: string | null;
        tournament_team_id_2: string | null;
      }>
    >(
      `SELECT match_id, finished, tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets WHERE id = $1`,
      [id],
    );
    return row;
  };

  const match = async (id: string) => {
    const [row] = await postgres.query<
      Array<{
        status: string;
        winning_lineup_id: string | null;
        scheduled_at: Date | null;
        lineup_players: string;
      }>
    >(
      `SELECT m.status, m.winning_lineup_id, m.scheduled_at,
              (SELECT count(*) FROM match_lineup_players mlp
                 JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
                WHERE ml.match_id = m.id) AS lineup_players
         FROM matches m WHERE m.id = $1`,
      [id],
    );
    return row;
  };

  const semis = async (stageId: string) =>
    (await tfx.getBrackets(stageId)).filter((b) => b.round === 1);

  const finalOf = async (stageId: string) =>
    (await tfx.getBrackets(stageId)).find((b) => b.round === 2)!;

  it("recreates the match of a slot whose unplayed match was deleted", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    expect((await bracket(semi.id)).match_id).toBeNull();

    const matchId = await recreate(semi.id);

    const slot = await bracket(semi.id);
    expect(slot.match_id).toBe(matchId);
    expect(slot.finished).toBe(false);
    expect(slot.tournament_team_id_1).toBe(semi.tournament_team_id_1);
    expect(slot.tournament_team_id_2).toBe(semi.tournament_team_id_2);

    const recreated = await match(matchId);
    expect(recreated.status).toBe("WaitingForCheckIn");
    expect(Number(recreated.lineup_players)).toBe(4);
  });

  it("parks a recreated match as Scheduled while its bracket's time is still ahead", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    await postgres.query(
      "UPDATE tournament_brackets SET scheduled_at = now() + interval '2 days' WHERE id = $1",
      [semi.id],
    );

    const recreated = await match(await recreate(semi.id));

    expect(recreated.status).toBe("Scheduled");
    expect(recreated.scheduled_at!.getTime()).toBeGreaterThan(
      Date.now() + 86_400_000,
    );
  });

  it("replays a won slot and unwinds the final it fed", async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const [semi, otherSemi] = await semis(t.stageIds[0]);
    const finalBefore = await finalOf(t.stageIds[0]);
    expect(finalBefore.match_id).not.toBeNull();

    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    expect(await bracket(semi.id)).toMatchObject({
      match_id: null,
      finished: true,
    });

    const matchId = await recreate(semi.id);

    expect(await bracket(semi.id)).toMatchObject({
      match_id: matchId,
      finished: false,
    });
    const recreated = await match(matchId);
    expect(recreated.status).toBe("WaitingForCheckIn");
    expect(recreated.winning_lineup_id).toBeNull();

    const final = await finalOf(t.stageIds[0]);
    expect(final.match_id).toBeNull();
    expect(await match(finalBefore.match_id!)).toBeUndefined();
    const finalTeams = [final.tournament_team_id_1, final.tournament_team_id_2];
    expect(finalTeams.filter((team) => team === null).length).toBe(1);
    expect(finalTeams).toContain(otherSemi.tournament_team_id_1);
  });

  it("refuses a slot that still has its match", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);

    await expect(recreate(semi.id)).rejects.toThrow(/already has a match/);
  });

  it("refuses a won slot whose final is already being played", async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const [semi] = await semis(t.stageIds[0]);
    const final = await finalOf(t.stageIds[0]);
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1`,
      [final.match_id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      final.match_id,
    ]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);

    await expect(recreate(semi.id)).rejects.toThrow(/downstream match is live/);

    expect(await bracket(semi.id)).toMatchObject({
      match_id: null,
      finished: true,
    });
    expect((await match(final.match_id!)).status).toBe("Live");
  });

  it("refuses a won slot in a round robin", async () => {
    const t = await tfx.launch(
      [{ type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 }],
      4,
    );
    const [first] = (await tfx.getBrackets(t.stageIds[0])).filter(
      (b) => b.round === 1,
    );
    await tfx.winMatch(first.match_id!);
    await postgres.query("DELETE FROM matches WHERE id = $1", [first.match_id]);

    await expect(recreate(first.id)).rejects.toThrow(/elimination/);
  });

  it("refuses once the tournament is no longer running", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    await tfx.setStatus(t.id, t.organizer, "Cancelled");

    await expect(recreate(semi.id)).rejects.toThrow(/not running/);
  });
});
