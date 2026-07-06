import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises reset_tournament_match / preview_tournament_match_reset: rewinding
// a reported result unwinds every downstream bracket (slot clearing, match
// deletion, unfinishing), restores the source match, and rolls a finished
// tournament back to Live with its auto trophies revoked.
describe("tournament match reset (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentResetTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199400000000n);
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

  const SE4 = [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }];

  // A finished four-team cup: both semifinals and the final won by lineup 1.
  const playedOutCup = async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.playRound(t.stageIds[0], 2);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    return t;
  };

  const resetMatch = (
    matchId: string,
    newWinner: string | null = null,
    status = "WaitingForCheckIn",
  ) =>
    postgres.query<Array<{ deleted_match_id: string }>>(
      "SELECT * FROM reset_tournament_match($1, $2, $3)",
      [matchId, newWinner, status],
    );

  it("previews the downstream chain of a reset", async () => {
    const t = await playedOutCup();
    const semi = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1 && b.match_number === 1,
    )!;

    const preview = await postgres.query<
      Array<{ depth: number; is_source: boolean; will_delete_match: boolean }>
    >("SELECT * FROM preview_tournament_match_reset($1) ORDER BY depth", [
      semi.match_id,
    ]);

    expect(preview.length).toBe(2);
    expect(preview[0]).toMatchObject({ is_source: true, will_delete_match: false });
    expect(preview[1]).toMatchObject({ is_source: false, will_delete_match: true });
  });

  it("resetting a semifinal unwinds the final and reopens the source match", async () => {
    const t = await playedOutCup();
    let brackets = await tfx.getBrackets(t.stageIds[0]);
    const semi1 = brackets.find((b) => b.round === 1 && b.match_number === 1)!;
    const semi2 = brackets.find((b) => b.round === 1 && b.match_number === 2)!;
    const finalMatchId = brackets.find((b) => b.round === 2)!.match_id;

    const deleted = await resetMatch(semi1.match_id!);
    expect(deleted.map((d) => d.deleted_match_id)).toEqual([finalMatchId]);

    brackets = await tfx.getBrackets(t.stageIds[0]);
    const final = brackets.find((b) => b.round === 2)!;
    // Only the reset feeder's slot is vacated; the other semifinal's winner keeps its seat.
    const finalTeams = [final.tournament_team_id_1, final.tournament_team_id_2];
    expect(finalTeams.filter((team) => team === null).length).toBe(1);
    expect(finalTeams).toContain(semi2.tournament_team_id_1);
    expect(final.match_id).toBeNull();
    expect(final.finished).toBe(false);

    expect(
      brackets.find((b) => b.id === semi1.id)!.finished,
    ).toBe(false);

    const [source] = await postgres.query<
      Array<{ status: string; winning_lineup_id: string | null }>
    >("SELECT status, winning_lineup_id FROM matches WHERE id = $1", [
      semi1.match_id,
    ]);
    expect(source.status).toBe("WaitingForCheckIn");
    expect(source.winning_lineup_id).toBeNull();
  });

  it("rolls a finished tournament back to Live and revokes its trophies", async () => {
    const t = await playedOutCup();
    expect(
      Number(
        (
          await postgres.query<Array<{ c: string }>>(
            "SELECT count(*) AS c FROM tournament_trophies WHERE tournament_id = $1",
            [t.id],
          )
        )[0].c,
      ),
    ).toBeGreaterThan(0);

    const semi = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;
    await resetMatch(semi.match_id!);

    expect(await tfx.tournamentStatus(t.id)).toBe("Live");
    const [{ c }] = await postgres.query<Array<{ c: string }>>(
      "SELECT count(*) AS c FROM tournament_trophies WHERE tournament_id = $1",
      [t.id],
    );
    expect(Number(c)).toBe(0);
  });

  it("resetting with a corrected winner repropagates the bracket", async () => {
    const t = await playedOutCup();
    let brackets = await tfx.getBrackets(t.stageIds[0]);
    const semi1 = brackets.find((b) => b.round === 1 && b.match_number === 1)!;
    // The team wrongly eliminated: semifinal 1's slot-2 team.
    const wrongedTeam = semi1.tournament_team_id_2;

    const [lineups] = await postgres.query<Array<{ lineup_2_id: string }>>(
      "SELECT lineup_2_id FROM matches WHERE id = $1",
      [semi1.match_id],
    );
    await resetMatch(semi1.match_id!, lineups.lineup_2_id);

    const [source] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM matches WHERE id = $1",
      [semi1.match_id],
    );
    expect(source.status).toBe("Finished");

    brackets = await tfx.getBrackets(t.stageIds[0]);
    const final = brackets.find((b) => b.round === 2)!;
    expect([
      final.tournament_team_id_1,
      final.tournament_team_id_2,
    ]).toContain(wrongedTeam);
    // Both finalists present again: a fresh final match is scheduled.
    expect(final.tournament_team_id_1).not.toBeNull();
    expect(final.tournament_team_id_2).not.toBeNull();
    expect(final.match_id).not.toBeNull();

    // Finish it again to bring the tournament back home.
    await tfx.winMatch(final.match_id!);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
  });

  it("refuses to reset live matches, foreign winners, and non-bracket matches", async () => {
    const t = await tfx.launch(SE4, 4);
    const semi = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;

    // A map so the match may go Live at all.
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1`,
      [semi.match_id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      semi.match_id,
    ]);
    await expect(resetMatch(semi.match_id!)).rejects.toThrow(
      /cannot reset a live match/i,
    );

    await postgres.query(
      "UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1",
      [semi.match_id],
    );
    await expect(
      resetMatch(semi.match_id!, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/new winner must be one of the source match lineups/i);

    const stray = await fx.match({ type: "Wingman", mr: 8 });
    await expect(resetMatch(stray.id)).rejects.toThrow(
      /not linked to a tournament bracket/i,
    );
  });
});
