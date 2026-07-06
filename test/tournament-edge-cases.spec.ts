import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Tournament edge cases beyond the happy paths: byes for non-power-of-two
// fields, the third-place match, upset-heavy Swiss runs driven by a seeded
// PRNG, and resetting a quarterfinal after the whole bracket played out.
describe("tournament edge cases (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentEdgeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199980000000n);
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

  // Deterministic PRNG so the upset runs are reproducible.
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const playAllRounds = async (
    stageId: string,
    rounds: number,
    pickWinner: () => "lineup_1_id" | "lineup_2_id" = () => "lineup_1_id",
  ) => {
    for (let round = 1; round <= rounds; round++) {
      const open = await postgres.query<Array<{ match_id: string }>>(
        `SELECT match_id FROM tournament_brackets
         WHERE tournament_stage_id = $1 AND round = $2
           AND match_id IS NOT NULL AND finished = false
         ORDER BY match_number`,
        [stageId, round],
      );
      for (const bracket of open) {
        await tfx.winMatch(bracket.match_id, pickWinner());
      }
    }
  };

  describe("byes", () => {
    it("a six-team field gives the top seeds a first-round bye and still completes", async () => {
      const t = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
        6,
      );
      const brackets = await tfx.getBrackets(t.stageIds[0]);

      // Two round-1 matches (the byes were pruned), two semis with one
      // pre-placed team each, one final.
      const roundOne = brackets.filter((b) => b.round === 1);
      expect(roundOne.length).toBe(2);
      expect(
        roundOne.every(
          (b) => b.tournament_team_id_1 !== null && b.tournament_team_id_2 !== null,
        ),
      ).toBe(true);

      const semis = brackets.filter((b) => b.round === 2);
      expect(semis.length).toBe(2);
      expect(
        semis.every((b) => b.tournament_team_id_1 !== null),
      ).toBe(true);

      await playAllRounds(t.stageIds[0], 3);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
      expect(
        (await tfx.getBrackets(t.stageIds[0])).every((b) => b.finished),
      ).toBe(true);
    });

    it("a five-team field resolves three byes and still completes", async () => {
      const t = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
        5,
      );
      await playAllRounds(t.stageIds[0], 3);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    });
  });

  describe("third-place match", () => {
    it("routes both semifinal losers into a playable third-place decider", async () => {
      const t = await tfx.createTournament([
        { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
      ]);
      await postgres.query(
        `UPDATE tournament_stages SET third_place_match = true WHERE tournament_id = $1`,
        [t.id],
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      for (let i = 0; i < 4; i++) {
        await tfx.registerTeam(t.id, await fx.team(1));
      }
      await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
      await tfx.setStatus(t.id, t.organizer, "Live");
      const stage = (
        await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM tournament_stages WHERE tournament_id = $1",
          [t.id],
        )
      )[0].id;

      let brackets = await tfx.getBrackets(stage);
      expect(brackets.filter((b) => b.round === 2).length).toBe(2); // final + 3rd place

      const semis = brackets.filter((b) => b.round === 1);
      const semiLosers = [
        semis[0].tournament_team_id_2, // lineup_1 wins below
        semis[1].tournament_team_id_2,
      ];
      await playAllRounds(stage, 1);

      brackets = await tfx.getBrackets(stage);
      const thirdPlace = brackets.find(
        (b) => b.round === 2 && b.match_number === 2,
      )!;
      expect(
        [thirdPlace.tournament_team_id_1, thirdPlace.tournament_team_id_2].sort(),
      ).toEqual([...semiLosers].sort());
      expect(thirdPlace.match_id).not.toBeNull();

      await playAllRounds(stage, 2);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

      // Bronze goes to the third-place winner, not just a semifinal loser.
      const bronzeTeams = await postgres.query<
        Array<{ tournament_team_id: string }>
      >(
        `SELECT DISTINCT tournament_team_id FROM tournament_trophies
         WHERE tournament_id = $1 AND placement = 3`,
        [t.id],
      );
      const finalThird = (await tfx.getBrackets(stage)).find(
        (b) => b.round === 2 && b.match_number === 2,
      )!;
      expect(bronzeTeams.map((b) => b.tournament_team_id)).toEqual([
        finalThird.tournament_team_id_1,
      ]);

      // And the trophies leaderboard hands each roster exactly its medal:
      // value/secondary/tertiary are the gold/silver/bronze counts.
      const finalBracket = (await tfx.getBrackets(stage)).find(
        (b) => b.round === 2 && b.match_number === 1,
      )!;
      const roster = async (teamId: string) =>
        (
          await postgres.query<Array<{ player_steam_id: string }>>(
            `SELECT player_steam_id FROM tournament_team_roster
             WHERE tournament_team_id = $1`,
            [teamId],
          )
        )
          .map((r) => r.player_steam_id)
          .sort();
      const trophies = await postgres.query<
        Array<{
          player_steam_id: string;
          value: number;
          secondary_value: number;
          tertiary_value: number;
        }>
      >("SELECT * FROM get_leaderboard('trophies', 0)");
      const medalists = (pick: (r: (typeof trophies)[number]) => number) =>
        trophies
          .filter((r) => Number(pick(r)) === 1)
          .map((r) => r.player_steam_id)
          .sort();

      expect(medalists((r) => r.value)).toEqual(
        await roster(finalBracket.tournament_team_id_1!),
      );
      expect(medalists((r) => r.secondary_value)).toEqual(
        await roster(finalBracket.tournament_team_id_2!),
      );
      expect(medalists((r) => r.tertiary_value)).toEqual(
        await roster(finalThird.tournament_team_id_1!),
      );
    });
  });

  describe("Swiss under upsets", () => {
    it("a random result sequence still lands on the exact Valve pool distribution", async () => {
      const t = await tfx.launch(
        [{ type: "Swiss", order: 1, minTeams: 16, maxTeams: 16 }],
        16,
      );
      const rng = mulberry32(0x5157ac);

      await playAllRounds(t.stageIds[0], 5, () =>
        rng() < 0.5 ? "lineup_1_id" : "lineup_2_id",
      );

      const results = await tfx.stageResults(t.stageIds[0]);
      const byRecord = new Map<string, number>();
      for (const row of results) {
        const key = `${row.wins}-${row.losses}`;
        byRecord.set(key, (byRecord.get(key) ?? 0) + 1);
      }
      // The pool math guarantees this distribution regardless of who wins.
      expect(Object.fromEntries(byRecord)).toEqual({
        "3-0": 2,
        "3-1": 3,
        "3-2": 3,
        "2-3": 3,
        "1-3": 3,
        "0-3": 2,
      });
      expect(
        (await tfx.getBrackets(t.stageIds[0])).every((b) => b.finished),
      ).toBe(true);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    }, 180_000);
  });

  describe("deep reset", () => {
    it("resetting a quarterfinal unwinds the whole chain and the bracket replays cleanly", async () => {
      const t = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 8, maxTeams: 8 }],
        8,
      );
      const stage = t.stageIds[0];
      await playAllRounds(stage, 3);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

      const quarterOne = (await tfx.getBrackets(stage)).find(
        (b) => b.round === 1 && b.match_number === 1,
      )!;

      const preview = await postgres.query<
        Array<{ depth: number; will_delete_match: boolean }>
      >("SELECT * FROM preview_tournament_match_reset($1) ORDER BY depth", [
        quarterOne.match_id,
      ]);
      // QF -> SF -> Final: three levels in the chain.
      expect(preview.length).toBe(3);
      expect(preview.filter((p) => p.will_delete_match).length).toBe(2);

      const deleted = await postgres.query<
        Array<{ deleted_match_id: string }>
      >("SELECT * FROM reset_tournament_match($1)", [quarterOne.match_id]);
      expect(deleted.length).toBe(2);

      expect(await tfx.tournamentStatus(t.id)).toBe("Live");
      const unwound = await tfx.getBrackets(stage);
      expect(unwound.filter((b) => !b.finished).length).toBe(3);

      // Replay: the reset quarterfinal, then the rescheduled semi and final.
      await tfx.winMatch(quarterOne.match_id!);
      await playAllRounds(stage, 2);
      await playAllRounds(stage, 3);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
      expect(
        (await tfx.getBrackets(stage)).every((b) => b.finished),
      ).toBe(true);
    });
  });
});
