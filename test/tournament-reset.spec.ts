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
    scheduledAt: string | null = null,
  ) =>
    postgres.query<Array<{ deleted_match_id: string }>>(
      "SELECT * FROM reset_tournament_match($1, $2, $3, $4)",
      [matchId, newWinner, status, scheduledAt],
    );

  // Wins every open match repeatedly until the bracket runs dry.
  const sweep = async (stageId: string) => {
    for (let i = 0; i < 12; i++) {
      const open = await postgres.query<Array<{ match_id: string }>>(
        `SELECT match_id FROM tournament_brackets
         WHERE tournament_stage_id = $1 AND match_id IS NOT NULL AND finished = false
         ORDER BY round, match_number`,
        [stageId],
      );
      if (!open.length) break;
      for (const bracket of open) {
        await tfx.winMatch(bracket.match_id);
      }
    }
  };

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

  it("reset to Scheduled applies the provided schedule", async () => {
    const t = await playedOutCup();
    const semi = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1 && b.match_number === 1,
    )!;

    const when = "2027-01-01T12:00:00.000Z";
    await resetMatch(semi.match_id!, null, "Scheduled", when);

    const [source] = await postgres.query<
      Array<{ status: string; scheduled_at: Date; winning_lineup_id: string | null }>
    >("SELECT status, scheduled_at, winning_lineup_id FROM matches WHERE id = $1", [
      semi.match_id,
    ]);
    expect(source.status).toBe("Scheduled");
    expect(new Date(source.scheduled_at).toISOString()).toBe(when);
    expect(source.winning_lineup_id).toBeNull();
  });

  // 22 teams in a 32-slot bracket: ten round-1 byes are pruned and their seeds
  // pushed into the round-2 parents. Round-2 match 5 holds the seed-2 bye team
  // in slot 1 with a single surviving round-1 feeder for slot 2.
  describe("byes in a 22-team bracket", () => {
    type SeededBracket = {
      id: string;
      match_id: string | null;
      team_1_seed: number | null;
      team_2_seed: number | null;
      tournament_team_id_1: string | null;
      tournament_team_id_2: string | null;
    };

    const getRoundTwoMatchFive = async (stageId: string) => {
      const [row] = await postgres.query<Array<SeededBracket>>(
        `SELECT id, match_id, team_1_seed, team_2_seed,
                tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets
         WHERE tournament_stage_id = $1 AND round = 2 AND match_number = 5`,
        [stageId],
      );
      return row;
    };

    const SE32 = [
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 32 },
    ];

    const launchAndPlayRoundOne = async () => {
      const t = await tfx.launch(SE32, 22);
      const stage = t.stageIds[0];

      const roundOne = (await tfx.getBrackets(stage)).filter(
        (b) => b.round === 1,
      );
      expect(roundOne.length).toBe(6);
      await tfx.playRound(stage, 1);

      const m5 = await getRoundTwoMatchFive(stage);
      // The pruned bye pushed its seed into slot 1; the feeder winner fills slot 2.
      expect(m5.team_1_seed).not.toBeNull();
      expect(m5.team_2_seed).toBeNull();
      expect(m5.tournament_team_id_1).not.toBeNull();
      expect(m5.tournament_team_id_2).not.toBeNull();

      const feeders = await postgres.query<
        Array<{ id: string; match_id: string }>
      >(
        `SELECT id, match_id FROM tournament_brackets WHERE parent_bracket_id = $1`,
        [m5.id],
      );
      expect(feeders.length).toBe(1);

      return { t, stage, m5, feederMatchId: feeders[0].match_id };
    };

    it("resetting the feeder into round-2 match 5 keeps the bye team seated", async () => {
      const { stage, m5, feederMatchId } = await launchAndPlayRoundOne();
      const byeTeam = m5.tournament_team_id_1;

      await resetMatch(feederMatchId);

      const after = await getRoundTwoMatchFive(stage);
      // Only the feeder's contribution (slot 2) is vacated; the bye team keeps its seat.
      expect(after.tournament_team_id_2).toBeNull();
      expect(after.tournament_team_id_1).toBe(byeTeam);

      // Replaying the feeder restores a playable round-2 match with both teams.
      await tfx.winMatch(feederMatchId);
      const replayed = await getRoundTwoMatchFive(stage);
      expect(replayed.tournament_team_id_1).toBe(byeTeam);
      expect(replayed.tournament_team_id_2).toBe(m5.tournament_team_id_2);
      expect(replayed.match_id).not.toBeNull();
    });

    it("resetting round-2 match 5 itself keeps both teams in place", async () => {
      const { stage, m5 } = await launchAndPlayRoundOne();

      await tfx.winMatch(m5.match_id!);
      await resetMatch(m5.match_id!);

      const after = await getRoundTwoMatchFive(stage);
      expect(after.tournament_team_id_1).toBe(m5.tournament_team_id_1);
      expect(after.tournament_team_id_2).toBe(m5.tournament_team_id_2);

      const [source] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [m5.match_id],
      );
      expect(source.status).toBe("WaitingForCheckIn");
    });

    it("a corrected feeder winner lands opposite the bye team", async () => {
      const { stage, m5, feederMatchId } = await launchAndPlayRoundOne();

      const [feeder] = await postgres.query<
        Array<{
          tournament_team_id_1: string;
          tournament_team_id_2: string;
        }>
      >(
        `SELECT tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets WHERE parent_bracket_id = $1`,
        [m5.id],
      );
      // Lineup 1 took round 1, so slot 2 currently holds the feeder's team 1.
      expect(m5.tournament_team_id_2).toBe(feeder.tournament_team_id_1);

      const [lineups] = await postgres.query<Array<{ lineup_2_id: string }>>(
        "SELECT lineup_2_id FROM matches WHERE id = $1",
        [feederMatchId],
      );
      await resetMatch(feederMatchId, lineups.lineup_2_id);

      const after = await getRoundTwoMatchFive(stage);
      expect(after.tournament_team_id_1).toBe(m5.tournament_team_id_1);
      expect(after.tournament_team_id_2).toBe(feeder.tournament_team_id_2);
      expect(after.match_id).not.toBeNull();
    });

    it("a deep reset after full playout keeps the bye seat and replays to a finish", async () => {
      const { t, stage, m5, feederMatchId } = await launchAndPlayRoundOne();
      for (let round = 2; round <= 5; round++) {
        await tfx.playRound(stage, round);
      }
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

      // Feeder -> R2M5 -> R3 -> R4 -> final: four downstream matches deleted.
      const deleted = await resetMatch(feederMatchId);
      expect(deleted.length).toBe(4);
      expect(await tfx.tournamentStatus(t.id)).toBe("Live");

      const after = await getRoundTwoMatchFive(stage);
      expect(after.tournament_team_id_1).toBe(m5.tournament_team_id_1);
      expect(after.tournament_team_id_2).toBeNull();

      // The sibling round-2 winner outside the chain keeps its round-3 seat.
      const [parent] = await postgres.query<
        Array<{
          tournament_team_id_1: string | null;
          tournament_team_id_2: string | null;
        }>
      >(
        `SELECT tournament_team_id_1, tournament_team_id_2 FROM tournament_brackets
         WHERE id = (SELECT parent_bracket_id FROM tournament_brackets WHERE id = $1)`,
        [m5.id],
      );
      expect(parent.tournament_team_id_1).toBeNull();
      expect(parent.tournament_team_id_2).not.toBeNull();

      await tfx.winMatch(feederMatchId);
      await sweep(stage);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM tournament_trophies WHERE tournament_id = $1",
        [t.id],
      );
      expect(Number(c)).toBeGreaterThan(0);
    });

    it("resetting a both-bye round-2 match keeps both seed-placed teams", async () => {
      const t = await tfx.launch(SE32, 22);
      const stage = t.stageIds[0];

      // Seeds 8v9 and 7v10 meet directly in round 2: both feeders were byes,
      // so both teams are seed-placed and a match exists from launch.
      const doubleByes = await postgres.query<
        Array<{
          id: string;
          match_id: string;
          parent_bracket_id: string;
          tournament_team_id_1: string;
          tournament_team_id_2: string;
        }>
      >(
        `SELECT id, match_id, parent_bracket_id, tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets
         WHERE tournament_stage_id = $1 AND round = 2
           AND team_1_seed IS NOT NULL AND team_2_seed IS NOT NULL
         ORDER BY match_number`,
        [stage],
      );
      expect(doubleByes.length).toBe(2);
      const bracket = doubleByes[0];
      expect(bracket.match_id).not.toBeNull();
      expect(bracket.tournament_team_id_1).not.toBeNull();
      expect(bracket.tournament_team_id_2).not.toBeNull();

      await tfx.winMatch(bracket.match_id);
      const parentSlots = () =>
        postgres.query<
          Array<{
            tournament_team_id_1: string | null;
            tournament_team_id_2: string | null;
          }>
        >(
          `SELECT tournament_team_id_1, tournament_team_id_2
           FROM tournament_brackets WHERE id = $1`,
          [bracket.parent_bracket_id],
        );
      expect((await parentSlots())[0].tournament_team_id_2).toBe(
        bracket.tournament_team_id_1,
      );

      await resetMatch(bracket.match_id);

      const [after] = await postgres.query<
        Array<{
          match_id: string | null;
          tournament_team_id_1: string | null;
          tournament_team_id_2: string | null;
        }>
      >(
        `SELECT match_id, tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets WHERE id = $1`,
        [bracket.id],
      );
      expect(after.tournament_team_id_1).toBe(bracket.tournament_team_id_1);
      expect(after.tournament_team_id_2).toBe(bracket.tournament_team_id_2);
      expect(after.match_id).toBe(bracket.match_id);

      const [parentAfter] = await parentSlots();
      expect(parentAfter.tournament_team_id_1).toBeNull();
      expect(parentAfter.tournament_team_id_2).toBeNull();
    });
  });

  // 4-team double elimination: WB r1m1/m2 -> WB final (r2) -> grand final (r3),
  // WB r1 losers meet in LB r1, whose winner faces the WB final loser in LB r2.
  describe("double elimination resets", () => {
    const DE4 = [
      { type: "DoubleElimination", order: 1, minTeams: 4, maxTeams: 4 },
    ];

    type DeBracket = {
      id: string;
      match_id: string | null;
      finished: boolean;
      tournament_team_id_1: string | null;
      tournament_team_id_2: string | null;
    };

    const getDe = async (stageId: string, path: string, round: number) => {
      const [row] = await postgres.query<Array<DeBracket>>(
        `SELECT id, match_id, finished, tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets
         WHERE tournament_stage_id = $1 AND path = $2 AND round = $3
         ORDER BY match_number`,
        [stageId, path, round],
      );
      return row;
    };

    const getWbRoundOne = (stageId: string) =>
      postgres.query<Array<DeBracket>>(
        `SELECT id, match_id, finished, tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets
         WHERE tournament_stage_id = $1 AND path = 'WB' AND round = 1
         ORDER BY match_number`,
        [stageId],
      );

    it("resetting a WB opener vacates its winner and loser drops, then replays", async () => {
      const t = await tfx.launch(DE4, 4);
      const stage = t.stageIds[0];

      const wbR1 = await getWbRoundOne(stage);
      await tfx.winMatch(wbR1[0].match_id!, "lineup_1_id");
      await tfx.winMatch(wbR1[1].match_id!, "lineup_2_id");

      // m1's winner/loser landed in slot 1 of the WB final / LB r1.
      const wbFinalBefore = await getDe(stage, "WB", 2);
      const lbBefore = await getDe(stage, "LB", 1);
      expect(wbFinalBefore.tournament_team_id_1).toBe(wbR1[0].tournament_team_id_1);
      expect(wbFinalBefore.tournament_team_id_2).toBe(wbR1[1].tournament_team_id_2);
      expect(lbBefore.tournament_team_id_1).toBe(wbR1[0].tournament_team_id_2);
      expect(lbBefore.tournament_team_id_2).toBe(wbR1[1].tournament_team_id_1);

      // Chain spans both parents: source, WB final, grand final, LB r1, LB final.
      const preview = await postgres.query<Array<{ bracket_id: string }>>(
        "SELECT * FROM preview_tournament_match_reset($1)",
        [wbR1[0].match_id],
      );
      expect(preview.length).toBe(5);

      const deleted = await resetMatch(wbR1[0].match_id!);
      expect(deleted.length).toBe(2); // WB final + LB r1 matches existed

      const wbFinal = await getDe(stage, "WB", 2);
      const lb = await getDe(stage, "LB", 1);
      expect(wbFinal.tournament_team_id_1).toBeNull();
      expect(wbFinal.tournament_team_id_2).toBe(wbR1[1].tournament_team_id_2);
      expect(wbFinal.match_id).toBeNull();
      expect(lb.tournament_team_id_1).toBeNull();
      expect(lb.tournament_team_id_2).toBe(wbR1[1].tournament_team_id_1);
      expect(lb.match_id).toBeNull();

      await tfx.winMatch(wbR1[0].match_id!, "lineup_1_id");
      await sweep(stage);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    });

    it("resetting the WB final unwinds the grand final and the LB final drop", async () => {
      const t = await tfx.launch(DE4, 4);
      const stage = t.stageIds[0];

      const wbR1 = await getWbRoundOne(stage);
      await tfx.winMatch(wbR1[0].match_id!);
      await tfx.winMatch(wbR1[1].match_id!);
      const lbR1 = await getDe(stage, "LB", 1);
      await tfx.winMatch(lbR1.match_id!);
      const wbFinal = await getDe(stage, "WB", 2);
      await tfx.winMatch(wbFinal.match_id!);

      // WB final loser owns LB final slot 1; the LB r1 winner keeps slot 2.
      const lbFinalBefore = await getDe(stage, "LB", 2);
      expect(lbFinalBefore.tournament_team_id_1).toBe(wbFinal.tournament_team_id_2);
      expect(lbFinalBefore.tournament_team_id_2).toBe(lbR1.tournament_team_id_1);
      await tfx.winMatch(lbFinalBefore.match_id!);

      const gfBefore = await getDe(stage, "WB", 3);
      expect(gfBefore.tournament_team_id_1).toBe(wbFinal.tournament_team_id_1);
      expect(gfBefore.tournament_team_id_2).toBe(wbFinal.tournament_team_id_2);
      expect(gfBefore.match_id).not.toBeNull();

      const deleted = await resetMatch(wbFinal.match_id!);
      expect(deleted.length).toBe(2); // LB final + grand final

      const gf = await getDe(stage, "WB", 3);
      const lbFinal = await getDe(stage, "LB", 2);
      expect(gf.tournament_team_id_1).toBeNull();
      expect(gf.tournament_team_id_2).toBeNull();
      expect(gf.match_id).toBeNull();
      expect(lbFinal.tournament_team_id_1).toBeNull();
      expect(lbFinal.tournament_team_id_2).toBe(lbR1.tournament_team_id_1);
      expect(lbFinal.match_id).toBeNull();
      expect(lbFinal.finished).toBe(false);

      // Replay with the other team winning: the new loser drops to LB final
      // slot 1, and the new WB champion takes grand final slot 1.
      await tfx.winMatch(wbFinal.match_id!, "lineup_2_id");
      const lbReplay = await getDe(stage, "LB", 2);
      expect(lbReplay.tournament_team_id_1).toBe(wbFinal.tournament_team_id_1);
      expect(lbReplay.tournament_team_id_2).toBe(lbR1.tournament_team_id_1);
      await tfx.winMatch(lbReplay.match_id!);

      const gfReplay = await getDe(stage, "WB", 3);
      expect(gfReplay.tournament_team_id_1).toBe(wbFinal.tournament_team_id_2);
      expect(gfReplay.tournament_team_id_2).toBe(lbReplay.tournament_team_id_1);
      await tfx.winMatch(gfReplay.match_id!);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    });
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

  // Swiss/RoundRobin results feed pool assignment and standings advancement
  // that the parent-chain unwind cannot restore, so resets are rejected.
  it("refuses to reset Swiss and RoundRobin matches", async () => {
    for (const [type, teams] of [
      ["Swiss", 16],
      ["RoundRobin", 4],
    ] as Array<[string, number]>) {
      const t = await tfx.launch(
        [{ type, order: 1, minTeams: teams, maxTeams: teams }],
        teams,
      );
      const bracket = (await tfx.getBrackets(t.stageIds[0])).find(
        (b) => b.match_id !== null,
      )!;
      await tfx.winMatch(bracket.match_id!);

      await expect(resetMatch(bracket.match_id!)).rejects.toThrow(
        /only elimination stage matches can be reset/i,
      );
      await expect(
        postgres.query("SELECT * FROM preview_tournament_match_reset($1)", [
          bracket.match_id,
        ]),
      ).rejects.toThrow(/only elimination stage matches can be reset/i);
    }
  });
});
