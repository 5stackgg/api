import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The podium is the tournament's result, so it shows whether or not awards are
// handed out, and it reads the same 1st/2nd/3rd the medals are granted from.
describe("tournament podium (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentPodiumTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199695000000n);
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

  type Step = {
    placement: number;
    tournament_team_id: string;
    name: string;
    players: Array<{ steam_id: string; name: string }>;
  };

  const podium = async (tournamentId: string): Promise<Array<Step> | null> => {
    const [row] = await postgres.query<Array<{ podium: Array<Step> | null }>>(
      "SELECT tournament_podium(t) AS podium FROM tournaments t WHERE t.id = $1",
      [tournamentId],
    );
    return row.podium;
  };

  const cup = async ({
    thirdPlaceMatch,
    awards = true,
  }: {
    thirdPlaceMatch: boolean;
    awards?: boolean;
  }) => {
    const t = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
    ]);
    await postgres.query(
      "UPDATE tournament_stages SET third_place_match = $2 WHERE tournament_id = $1",
      [t.id, thirdPlaceMatch],
    );
    await postgres.query(
      "UPDATE tournaments SET awards_enabled = $2 WHERE id = $1",
      [t.id, awards],
    );
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
    await tfx.setStatus(t.id, t.organizer, "Live");
    return t;
  };

  const roundRobin = async (groups: number) => {
    const teams = groups * 3;
    const t = await tfx.createTournament([
      {
        type: "RoundRobin",
        order: 1,
        minTeams: teams,
        maxTeams: teams,
        groups,
      },
    ]);
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < teams; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
    await tfx.setStatus(t.id, t.organizer, "Live");
    await tfx.playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    return t;
  };

  const placementMedals = (tournamentId: string) =>
    postgres.query<Array<{ placement: number; tournament_team_id: string }>>(
      `SELECT placement, tournament_team_id FROM award_recipients
        WHERE tournament_id = $1 AND source = 'tournament'
          AND team_id IS NOT NULL AND placement BETWEEN 1 AND 3
        ORDER BY placement`,
      [tournamentId],
    );

  const finalRound = (stageId: string) =>
    postgres.query<
      Array<{
        match_number: number;
        match_id: string;
        team_1: string;
        team_2: string;
      }>
    >(
      `SELECT match_number, match_id, tournament_team_id_1 AS team_1, tournament_team_id_2 AS team_2
         FROM tournament_brackets
        WHERE tournament_stage_id = $1 AND round = 2 AND path = 'WB'
        ORDER BY match_number`,
      [stageId],
    );

  it("orders 1st, 2nd and 3rd from the final and the third-place decider", async () => {
    const t = await cup({ thirdPlaceMatch: true });
    expect(await podium(t.id)).toBeNull();

    await tfx.playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

    const [final, decider] = await finalRound(t.stageIds[0]);
    const steps = (await podium(t.id))!;

    expect(
      steps.map((step) => [step.placement, step.tournament_team_id]),
    ).toEqual([
      [1, final.team_1],
      [2, final.team_2],
      [3, decider.team_1],
    ]);
    for (const step of steps) {
      expect(step.name).toBeTruthy();
      expect(step.players.length).toBeGreaterThan(0);
    }
  });

  it("puts both semifinal losers at 3rd when there is no third-place match", async () => {
    const t = await cup({ thirdPlaceMatch: false });
    await tfx.playStage(t.stageIds[0]);

    const steps = (await podium(t.id))!;

    expect(steps.map((step) => step.placement)).toEqual([1, 2, 3, 3]);
  });

  it("hands out no bronze for a shared 3rd", async () => {
    const t = await cup({ thirdPlaceMatch: false });
    await tfx.playStage(t.stageIds[0]);

    const placements = await postgres.query<Array<{ placement: number }>>(
      `SELECT DISTINCT placement FROM award_recipients
        WHERE tournament_id = $1 AND source = 'tournament' AND placement > 0
        ORDER BY placement`,
      [t.id],
    );
    expect(placements.map((row) => row.placement)).toEqual([1, 2]);
  });

  it("still shows the podium when awards are off, and grants nothing", async () => {
    const t = await cup({ thirdPlaceMatch: true, awards: false });
    await tfx.playStage(t.stageIds[0]);

    expect((await podium(t.id))!.map((step) => step.placement)).toEqual([
      1, 2, 3,
    ]);
    const [{ granted }] = await postgres.query<Array<{ granted: number }>>(
      "SELECT count(*)::int AS granted FROM award_recipients WHERE tournament_id = $1",
      [t.id],
    );
    expect(granted).toBe(0);
  });

  it("medals the same teams the podium shows", async () => {
    const t = await cup({ thirdPlaceMatch: true });
    await tfx.playStage(t.stageIds[0]);

    const medals = await postgres.query<
      Array<{ placement: number; tournament_team_id: string }>
    >(
      `SELECT placement, tournament_team_id FROM award_recipients
        WHERE tournament_id = $1 AND source = 'tournament'
          AND team_id IS NOT NULL AND placement BETWEEN 1 AND 3
        ORDER BY placement`,
      [t.id],
    );
    expect(medals).toEqual(
      (await podium(t.id))!.map(({ placement, tournament_team_id }) => ({
        placement,
        tournament_team_id,
      })),
    );
  });

  it("has no podium and hands out no medals when the final was never won", async () => {
    const t = await cup({ thirdPlaceMatch: false });
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.setStatus(t.id, t.organizer, "Finished");

    expect(await podium(t.id)).toEqual([]);
    expect(await placementMedals(t.id)).toEqual([]);
  });

  it("has no podium when only the third-place match was played", async () => {
    const t = await cup({ thirdPlaceMatch: true });
    await tfx.playRound(t.stageIds[0], 1);
    const [, decider] = await finalRound(t.stageIds[0]);
    await tfx.winMatch(decider.match_id);
    await tfx.setStatus(t.id, t.organizer, "Finished");

    expect(await podium(t.id)).toEqual([]);
    expect(await placementMedals(t.id)).toEqual([]);
  });

  it("still puts a won final on the podium when the third-place match was never played", async () => {
    const t = await cup({ thirdPlaceMatch: true });
    await tfx.playRound(t.stageIds[0], 1);
    const [final] = await finalRound(t.stageIds[0]);
    await tfx.winMatch(final.match_id);
    await tfx.setStatus(t.id, t.organizer, "Finished");

    const steps = (await podium(t.id))!;

    expect(steps.slice(0, 2).map((step) => step.tournament_team_id)).toEqual([
      final.team_1,
      final.team_2,
    ]);
    expect(steps.map((step) => step.placement)).toEqual([1, 2, 3, 3]);
  });

  it("takes a round robin's podium from its standings, medals included", async () => {
    const t = await roundRobin(1);

    const steps = (await podium(t.id))!;

    expect(steps.map((step) => step.placement)).toEqual([1, 2, 3]);
    expect(await placementMedals(t.id)).toEqual(
      steps.map(({ placement, tournament_team_id }) => ({
        placement,
        tournament_team_id,
      })),
    );
  });

  it("has no podium and hands out no medals when the last stage ran in groups", async () => {
    const t = await roundRobin(2);

    expect(await podium(t.id)).toEqual([]);
    expect(await placementMedals(t.id)).toEqual([]);
  });

  describe("double elimination", () => {
    const DE4 = [
      { type: "DoubleElimination", order: 1, minTeams: 4, maxTeams: 4 },
    ];

    const grandFinal = async (stageId: string) => {
      const [bracket] = await postgres.query<
        Array<{
          id: string;
          match_id: string | null;
          team_1: string | null;
          team_2: string | null;
          bye: boolean;
        }>
      >(
        `SELECT id, match_id, tournament_team_id_1 AS team_1,
                tournament_team_id_2 AS team_2, bye
           FROM tournament_brackets
          WHERE tournament_stage_id = $1 AND path = 'WB'
          ORDER BY round DESC, match_number
          LIMIT 1`,
        [stageId],
      );
      return bracket;
    };

    const playToGrandFinal = async (stageId: string) => {
      const { id } = await grandFinal(stageId);
      for (;;) {
        const open = await postgres.query<Array<{ match_id: string }>>(
          `SELECT match_id FROM tournament_brackets
            WHERE tournament_stage_id = $1 AND id <> $2
              AND match_id IS NOT NULL AND finished = false
            ORDER BY round, match_number`,
          [stageId, id],
        );
        if (open.length === 0) {
          return;
        }
        for (const bracket of open) {
          await tfx.winMatch(bracket.match_id);
        }
      }
    };

    it("has no podium and hands out no medals when it finished before its grand final", async () => {
      const t = await tfx.launch(DE4, 4);
      await playToGrandFinal(t.stageIds[0]);
      expect((await grandFinal(t.stageIds[0])).match_id).not.toBeNull();
      await tfx.setStatus(t.id, t.organizer, "Finished");

      expect(await podium(t.id)).toEqual([]);
      expect(await placementMedals(t.id)).toEqual([]);
    });

    it("puts the grand final's winner first once it is played", async () => {
      const t = await tfx.launch(DE4, 4);
      await playToGrandFinal(t.stageIds[0]);
      const final = await grandFinal(t.stageIds[0]);
      await tfx.winMatch(final.match_id!, "lineup_2_id");
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

      const steps = (await podium(t.id))!;

      expect(steps.map((step) => step.placement)).toEqual([1, 2, 3]);
      expect(steps.slice(0, 2).map((step) => step.tournament_team_id)).toEqual([
        final.team_2,
        final.team_1,
      ]);
      expect(await placementMedals(t.id)).toEqual(
        steps.map(({ placement, tournament_team_id }) => ({
          placement,
          tournament_team_id,
        })),
      );
    });

    it("counts a grand final its lone finalist reached by a bye", async () => {
      const t = await tfx.launch(
        [
          { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 },
          { type: "DoubleElimination", order: 2, minTeams: 2, maxTeams: 2 },
        ],
        4,
      );
      await tfx.playStage(t.stageIds[0]);
      await playToGrandFinal(t.stageIds[1]);
      expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

      const final = await grandFinal(t.stageIds[1]);
      expect(final.bye).toBe(true);

      const steps = (await podium(t.id))!;

      expect(steps.map((step) => step.placement)).toEqual([1, 2]);
      expect(steps[0].tournament_team_id).toBe(final.team_1 ?? final.team_2);
    });
  });
});
