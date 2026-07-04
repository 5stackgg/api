import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the Swiss and RoundRobin stage SQL: bracket generation shape,
// per-round scheduling, W/L pool routing (Swiss), full playthroughs, stage
// minimum propagation across stages, and multi-stage advancement into an
// elimination stage.
describe("tournament stages: Swiss and RoundRobin (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentStagesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199300000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // Matches before tournaments: bracket cascade triggers touch sibling
    // brackets mid-delete otherwise.
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  describe("RoundRobin", () => {
    const RR4 = [
      { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 },
    ];

    it("seeds a full schedule with teams pre-assigned and only round 1 scheduled", async () => {
      const t = await tfx.launch(RR4, 4);
      const brackets = await tfx.getBrackets(t.stageIds[0]);

      // 4 teams: 3 rounds of 2 matches, every pairing known up front.
      expect(brackets.map((b) => b.round)).toEqual([1, 1, 2, 2, 3, 3]);
      expect(
        brackets.every(
          (b) => b.tournament_team_id_1 !== null && b.tournament_team_id_2 !== null,
        ),
      ).toBe(true);

      // Every team meets every other exactly once.
      const pairings = brackets.map((b) =>
        [b.tournament_team_id_1, b.tournament_team_id_2].sort().join("|"),
      );
      expect(new Set(pairings).size).toBe(6);

      // Only round 1 has matches created.
      expect(
        brackets.filter((b) => b.match_id !== null).map((b) => b.round),
      ).toEqual([1, 1]);
    });

    it("finishing a round schedules the next one", async () => {
      const t = await tfx.launch(RR4, 4);
      await tfx.playRound(t.stageIds[0], 1);

      const brackets = await tfx.getBrackets(t.stageIds[0]);
      expect(
        brackets.filter((b) => b.match_id !== null).map((b) => b.round),
      ).toEqual([1, 1, 2, 2]);
      expect(
        brackets.filter((b) => b.round === 1).every((b) => b.finished),
      ).toBe(true);
    });

    it("playing every round finishes the tournament with a complete table", async () => {
      const t = await tfx.launch(RR4, 4);
      for (let round = 1; round <= 3; round++) {
        await tfx.playRound(t.stageIds[0], round);
      }

      const results = await tfx.stageResults(t.stageIds[0]);
      expect(results.length).toBe(4);
      // Everyone played all three of their games.
      expect(
        results.every((r) => Number(r.wins) + Number(r.losses) === 3),
      ).toBe(true);

      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    });
  });

  describe("Swiss (Valve format)", () => {
    const SWISS16 = [{ type: "Swiss", order: 1, minTeams: 16, maxTeams: 16 }];

    it("generates the full pool structure up front and schedules round 1", async () => {
      const t = await tfx.launch(SWISS16, 16);
      const brackets = await tfx.getBrackets(t.stageIds[0]);

      const perRound = (round: number) =>
        brackets.filter((b) => b.round === round).length;
      expect([1, 2, 3, 4, 5].map(perRound)).toEqual([8, 8, 8, 6, 3]);

      const round1 = brackets.filter((b) => b.round === 1);
      expect(round1.every((b) => b.match_id !== null)).toBe(true);
      expect(
        round1.every(
          (b) => b.tournament_team_id_1 !== null && b.tournament_team_id_2 !== null,
        ),
      ).toBe(true);
    });

    it("routes round-1 winners into the 1-0 pool and losers into the 0-1 pool", async () => {
      const t = await tfx.launch(SWISS16, 16);
      await tfx.playRound(t.stageIds[0], 1);

      const brackets = await tfx.getBrackets(t.stageIds[0]);
      const round2 = brackets.filter((b) => b.round === 2);

      // Pool group encodes wins*100 + losses.
      const winnersPool = round2.filter((b) => Number(b.group) === 100);
      const losersPool = round2.filter((b) => Number(b.group) === 1);
      expect(winnersPool.length).toBe(4);
      expect(losersPool.length).toBe(4);
      for (const bracket of [...winnersPool, ...losersPool]) {
        expect(bracket.tournament_team_id_1).not.toBeNull();
        expect(bracket.tournament_team_id_2).not.toBeNull();
        expect(bracket.match_id).not.toBeNull();
      }

      // Round-1 winners all sit in the winners pool.
      const round1Winners = new Set(
        brackets
          .filter((b) => b.round === 1)
          .map((b) => b.tournament_team_id_1),
      );
      const winnersPoolTeams = winnersPool.flatMap((b) => [
        b.tournament_team_id_1,
        b.tournament_team_id_2,
      ]);
      expect(winnersPoolTeams.every((team) => round1Winners.has(team))).toBe(
        true,
      );
    });

    it("plays five rounds to the exact Valve results distribution and finishes", async () => {
      const t = await tfx.launch(SWISS16, 16);
      for (let round = 1; round <= 5; round++) {
        await tfx.playRound(t.stageIds[0], round);
      }

      const results = await tfx.stageResults(t.stageIds[0]);
      const distribution = new Map<string, number>();
      for (const row of results) {
        const key = `${row.wins}-${row.losses}`;
        distribution.set(key, (distribution.get(key) ?? 0) + 1);
      }
      expect(Object.fromEntries(distribution)).toEqual({
        "3-0": 2,
        "3-1": 3,
        "3-2": 3,
        "2-3": 3,
        "1-3": 3,
        "0-3": 2,
      });

      const brackets = await tfx.getBrackets(t.stageIds[0]);
      expect(brackets.every((b) => b.finished)).toBe(true);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    }, 120_000);

    it("an 8-team Swiss fails with a clean error once a pool goes odd", async () => {
      // Valve Swiss pool math needs 16 teams: with 8, completing round 3
      // leaves three 2-1 teams (and three 1-2 teams) with no adjacent pool.
      // The pairing SQL now surfaces a real error instead of crashing with
      // 'record preferred_pool is not assigned yet'.
      const t = await tfx.launch(
        [{ type: "Swiss", order: 1, minTeams: 8, maxTeams: 8 }],
        8,
      );
      await tfx.playRound(t.stageIds[0], 1);
      await tfx.playRound(t.stageIds[0], 2);

      await expect(tfx.playRound(t.stageIds[0], 3)).rejects.toThrow(
        /Odd number of teams in pool/i,
      );
    });
  });

  describe("multi-stage advancement", () => {
    it("adding a later stage raises earlier stage minimums (halving rule)", async () => {
      const t = await tfx.createTournament([
        { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 8 },
      ]);
      await postgres.query(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 2, 4, 4)`,
        [t.id],
      );

      const [stage1] = await postgres.query<Array<{ min_teams: number }>>(
        `SELECT min_teams FROM tournament_stages WHERE tournament_id = $1 AND "order" = 1`,
        [t.id],
      );
      expect(Number(stage1.min_teams)).toBe(8);
    });

    it("a RoundRobin stage feeds its top teams into the elimination stage", async () => {
      const t = await tfx.launch(
        [
          { type: "RoundRobin", order: 1, minTeams: 8, maxTeams: 8 },
          { type: "SingleElimination", order: 2, minTeams: 4, maxTeams: 4 },
        ],
        8,
      );

      // 8-team round robin: 7 rounds of 4 matches.
      for (let round = 1; round <= 7; round++) {
        await tfx.playRound(t.stageIds[0], round);
      }
      expect(
        (await tfx.getBrackets(t.stageIds[0])).every((b) => b.finished),
      ).toBe(true);
      expect(await tfx.tournamentStatus(t.id)).toBe("Live");

      // Stage 2 semifinals seeded with four distinct stage-1 teams, matches up.
      const stage2 = await tfx.getBrackets(t.stageIds[1]);
      const semis = stage2.filter((b) => b.round === 1);
      expect(semis.length).toBe(2);
      const seededTeams = semis.flatMap((b) => [
        b.tournament_team_id_1,
        b.tournament_team_id_2,
      ]);
      expect(seededTeams.every((team) => team !== null)).toBe(true);
      expect(new Set(seededTeams).size).toBe(4);
      expect(semis.every((b) => b.match_id !== null)).toBe(true);

      // The stage-1 leader is among the advancers.
      const results = await tfx.stageResults(t.stageIds[0]);
      expect(seededTeams).toContain(results[0].tournament_team_id);

      // Play out the elimination stage: semifinals then the final.
      await tfx.playRound(t.stageIds[1], 1);
      await tfx.playRound(t.stageIds[1], 2);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    }, 120_000);
  });
});
