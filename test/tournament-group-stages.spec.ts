import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { BracketRow, TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

describe("tournament stages: grouped RoundRobin advancement (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentGroupStagesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199320000000n);
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

  type Standing = {
    tournament_team_id: string;
    group_number: number;
    rank: number;
    wins: number;
    losses: number;
  };

  const stageRow = async (stageId: string) =>
    (
      await postgres.query<Array<{ min_teams: number; max_teams: number }>>(
        "SELECT min_teams, max_teams FROM tournament_stages WHERE id = $1",
        [stageId],
      )
    )[0];

  const insertStage = (
    tournamentId: string,
    type: string,
    order: number,
    minTeams: number,
    maxTeams: number,
    groups = 1,
  ) =>
    postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams, groups)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tournamentId, type, order, minTeams, maxTeams, groups],
    );

  const groupSizes = async (stageId: string) =>
    (
      await postgres.query<Array<{ teams: number }>>(
        `SELECT count(DISTINCT team)::int AS teams FROM (
           SELECT "group", tournament_team_id_1 AS team FROM tournament_brackets WHERE tournament_stage_id = $1
           UNION ALL
           SELECT "group", tournament_team_id_2 FROM tournament_brackets WHERE tournament_stage_id = $1
         ) slots
         WHERE team IS NOT NULL
         GROUP BY "group" ORDER BY "group"`,
        [stageId],
      )
    ).map((row) => Number(row.teams));

  const standings = (stageId: string) =>
    postgres.query<Array<Standing>>(
      `SELECT tournament_team_id, group_number, rank, wins, losses
       FROM v_team_stage_results WHERE tournament_stage_id = $1
       ORDER BY group_number, rank`,
      [stageId],
    );

  const teamAt = (rows: Array<Standing>, group: number, rank: number) =>
    rows.find(
      (row) => Number(row.group_number) === group && Number(row.rank) === rank,
    )!.tournament_team_id;

  const teamsInRound = async (stageId: string, round: number) =>
    (await tfx.getBrackets(stageId))
      .filter((bracket) => bracket.round === round)
      .flatMap((bracket) => [
        bracket.tournament_team_id_1,
        bracket.tournament_team_id_2,
      ])
      .filter((team): team is string => team !== null)
      .sort();

  // Outside `strictGroups` slots 1-3 beat each other in a cycle, so a runner-up only goes 1-2.
  const scriptedResults = async (
    tournamentId: string,
    groups: number,
    strictGroups: Set<number>,
  ) => {
    const seeds = new Map(
      (
        await postgres.query<Array<{ id: string; seed: number }>>(
          "SELECT id, seed FROM tournament_teams WHERE tournament_id = $1",
          [tournamentId],
        )
      ).map((row) => [row.id, Number(row.seed)]),
    );
    return (bracket: BracketRow): "lineup_1_id" | "lineup_2_id" => {
      const group = Number(bracket.group);
      const slot = (team: string) => (seeds.get(team)! - group) / groups;
      const a = slot(bracket.tournament_team_id_1!);
      const b = slot(bracket.tournament_team_id_2!);
      let firstWins: boolean;
      if (a === 0 || b === 0) {
        firstWins = a === 0;
      } else if (strictGroups.has(group)) {
        firstWins = a < b;
      } else {
        firstWins = (b - a + 3) % 3 === 1;
      }
      return firstWins ? "lineup_1_id" : "lineup_2_id";
    };
  };

  describe("#507 advancement is sized by the next stage, not by group size", () => {
    it("resizing a 4-group round robin to 20 teams leaves the 8-team playoff alone", async () => {
      const t = await tfx.createTournament([
        { type: "RoundRobin", order: 1, minTeams: 16, maxTeams: 16, groups: 4 },
        { type: "DoubleElimination", order: 2, minTeams: 8, maxTeams: 8 },
      ]);

      await expect(
        postgres.query(
          "UPDATE tournament_stages SET min_teams = 20, max_teams = 20 WHERE id = $1",
          [t.stageIds[0]],
        ),
      ).resolves.toBeDefined();

      expect(await stageRow(t.stageIds[1])).toEqual({
        min_teams: 8,
        max_teams: 8,
      });
    });

    it("a later stage after a round robin doesn't inflate the round robin", async () => {
      const t = await tfx.createTournament([
        { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 8 },
        { type: "SingleElimination", order: 2, minTeams: 4, maxTeams: 4 },
      ]);

      expect(await stageRow(t.stageIds[0])).toEqual({
        min_teams: 4,
        max_teams: 8,
      });
    });

    it("a round robin can't advance more teams than it holds", async () => {
      const grouped = await tfx.createTournament([
        { type: "RoundRobin", order: 1, minTeams: 8, maxTeams: 8, groups: 2 },
      ]);

      await expect(
        insertStage(grouped.id, "SingleElimination", 2, 16, 16),
      ).rejects.toThrow(/holds at most 8 teams/i);
      expect(await stageRow(grouped.stageIds[0])).toEqual({
        min_teams: 8,
        max_teams: 8,
      });

      const single = await tfx.createTournament([
        { type: "RoundRobin", order: 1, minTeams: 8, maxTeams: 8 },
        { type: "SingleElimination", order: 2, minTeams: 8, maxTeams: 8 },
      ]);

      await expect(
        postgres.query(
          "UPDATE tournament_stages SET min_teams = 6, max_teams = 6 WHERE id = $1",
          [single.stageIds[0]],
        ),
      ).rejects.toThrow(/holds at most 6 teams/i);
    });

    it("six groups feeding eight: every group winner plus the two best runners-up", async () => {
      const t = await tfx.launch(
        [
          {
            type: "RoundRobin",
            order: 1,
            minTeams: 24,
            maxTeams: 24,
            groups: 6,
          },
          { type: "SingleElimination", order: 2, minTeams: 8, maxTeams: 8 },
        ],
        24,
      );
      const [roundRobin, playoff] = t.stageIds;

      await tfx.playStage(
        roundRobin,
        await scriptedResults(t.id, 6, new Set([5, 6])),
      );

      const table = await standings(roundRobin);
      expect(
        table
          .filter((row) => Number(row.rank) === 2)
          .map((row) => `${row.group_number}:${row.wins}-${row.losses}`),
      ).toEqual(["1:1-2", "2:1-2", "3:1-2", "4:1-2", "5:2-1", "6:2-1"]);

      expect(await teamsInRound(playoff, 1)).toEqual(
        [
          ...[1, 2, 3, 4, 5, 6].map((group) => teamAt(table, group, 1)),
          teamAt(table, 5, 2),
          teamAt(table, 6, 2),
        ].sort(),
      );

      await tfx.playStage(playoff);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    }, 180_000);
  });

  describe("a group left short of its guaranteed places", () => {
    it("gives the empty seed to the best wildcard instead of a bye", async () => {
      const t = await tfx.launch(
        [
          {
            type: "RoundRobin",
            order: 1,
            minTeams: 10,
            maxTeams: 10,
            groups: 2,
          },
          { type: "SingleElimination", order: 2, minTeams: 8, maxTeams: 8 },
        ],
        10,
      );
      const [roundRobin] = t.stageIds;

      await tfx.playStage(
        roundRobin,
        await scriptedResults(t.id, 2, new Set([1, 2])),
      );

      const table = await standings(roundRobin);
      const disqualified = [teamAt(table, 2, 4), teamAt(table, 2, 5)];
      await postgres.query(
        "UPDATE tournament_teams SET eligible_at = NULL WHERE id = ANY($1)",
        [disqualified],
      );

      const seeds = await postgres.query<
        Array<{ seed: number; tournament_team_id: string }>
      >(
        "SELECT seed, tournament_team_id FROM get_stage_qualifier_seeds($1, 8) ORDER BY seed",
        [roundRobin],
      );

      expect(seeds.map((row) => Number(row.seed))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(seeds.map((row) => row.tournament_team_id).sort()).toEqual(
        [
          ...[1, 2, 3, 4, 5].map((rank) => teamAt(table, 1, rank)),
          ...[1, 2, 3].map((rank) => teamAt(table, 2, rank)),
        ].sort(),
      );
    }, 120_000);
  });

  describe("#617 any number of teams can advance", () => {
    it("an 8-team round robin (min 4) feeds a 2-seat playoff, the shape start_league_season builds", async () => {
      const t = await tfx.createTournament([
        { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 8 },
      ]);

      await expect(
        insertStage(t.id, "SingleElimination", 2, 2, 4),
      ).resolves.toBeDefined();
    });

    it("a 10-team no-elimination Swiss (min 4) feeds a 2-seat playoff, the other shape start_league_season builds", async () => {
      const t = await tfx.createTournament([]);
      const [swiss] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams, groups, max_rounds, swiss_no_elimination)
         VALUES ($1, 'Swiss', 1, 4, 10, 1, 4, true) RETURNING id`,
        [t.id],
      );

      await expect(
        insertStage(t.id, "SingleElimination", 2, 2, 4),
      ).resolves.toBeDefined();
      await expect(
        postgres.query(
          "UPDATE tournament_stages SET min_teams = 3, max_teams = 3 WHERE id = $1",
          [swiss.id],
        ),
      ).rejects.toThrow(/holds at most 3 teams/i);
    });

    it("two group winners advance into a single final", async () => {
      const t = await tfx.launch(
        [
          { type: "RoundRobin", order: 1, minTeams: 8, maxTeams: 8, groups: 2 },
          { type: "SingleElimination", order: 2, minTeams: 2, maxTeams: 2 },
        ],
        8,
      );
      const [roundRobin, final] = t.stageIds;

      expect((await tfx.getBrackets(final)).length).toBe(1);

      await tfx.playStage(roundRobin);
      const table = await standings(roundRobin);

      const [bracket] = await tfx.getBrackets(final);
      expect(
        [bracket.tournament_team_id_1, bracket.tournament_team_id_2].sort(),
      ).toEqual([teamAt(table, 1, 1), teamAt(table, 2, 1)].sort());
      expect(bracket.match_id).not.toBeNull();

      await tfx.playStage(final);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    }, 120_000);
  });

  describe("#618 a group needs three teams, not four", () => {
    it("a 4-group round robin takes 15 teams and plays groups of 4, 4, 4 and 3", async () => {
      const t = await tfx.launch(
        [
          {
            type: "RoundRobin",
            order: 1,
            minTeams: 15,
            maxTeams: 16,
            groups: 4,
          },
          { type: "SingleElimination", order: 2, minTeams: 4, maxTeams: 4 },
        ],
        15,
      );
      const [roundRobin, playoff] = t.stageIds;

      expect(await groupSizes(roundRobin)).toEqual([4, 4, 4, 3]);

      await tfx.playStage(roundRobin);
      expect(
        (await tfx.getBrackets(roundRobin)).every(
          (bracket) => bracket.finished,
        ),
      ).toBe(true);

      const table = await standings(roundRobin);
      expect(await teamsInRound(playoff, 1)).toEqual(
        [1, 2, 3, 4].map((group) => teamAt(table, group, 1)).sort(),
      );

      await tfx.playStage(playoff);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    }, 120_000);

    it("wildcards compare win rate, so a 3-team group's runner-up isn't punished for playing fewer games", async () => {
      const t = await tfx.launch(
        [
          {
            type: "RoundRobin",
            order: 1,
            minTeams: 15,
            maxTeams: 16,
            groups: 4,
          },
          { type: "SingleElimination", order: 2, minTeams: 6, maxTeams: 6 },
        ],
        15,
      );
      const [roundRobin, playoff] = t.stageIds;

      await tfx.playStage(
        roundRobin,
        await scriptedResults(t.id, 4, new Set([4])),
      );

      const table = await standings(roundRobin);
      expect(
        table
          .filter((row) => Number(row.rank) === 2)
          .map((row) => `${row.group_number}:${row.wins}-${row.losses}`),
      ).toEqual(["1:1-2", "2:1-2", "3:1-2", "4:1-1"]);

      // Seeds 1 and 2 of a 6-team bracket take byes straight into round 2.
      const field = new Set([
        ...(await teamsInRound(playoff, 1)),
        ...(await teamsInRound(playoff, 2)),
      ]);

      expect(field.size).toBe(6);
      for (const group of [1, 2, 3, 4]) {
        expect(field.has(teamAt(table, group, 1))).toBe(true);
      }
      expect(field.has(teamAt(table, 4, 2))).toBe(true);
    }, 120_000);

    it("groups smaller than three teams are still rejected", async () => {
      const t = await tfx.createTournament([]);

      await expect(
        insertStage(t.id, "RoundRobin", 1, 11, 16, 4),
      ).rejects.toThrow(/3 teams per group/i);
      await expect(
        insertStage(t.id, "RoundRobin", 1, 3, 3, 1),
      ).resolves.toBeDefined();
    });
  });
});
