import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// An organizer changed a tournament's map pool after the bracket was drawn and
// the matches that had not started yet picked the new pool up. The pool is
// fixed once the bracket is drawn; every other setting of the tournament's
// options keeps reaching those matches.
describe("a tournament's map pool once the bracket is drawn (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  type Tournament = { id: string; organizer: string; stageIds: Array<string> };
  type Options = { id: string; map_pool_id: string; tv_delay: number };

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
  ];

  const REFUSAL =
    /Unable to change the map pool once the bracket has been drawn/;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentMapPoolLockTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199860000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27017);
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

  // What TournamentStageForm.createMatchOptions leaves behind: the stage holds
  // its own full copy of the tournament's options.
  const tournamentWithStageOptions = async () => {
    const tournament = await tfx.createTournament(SE4);
    await postgres.query(
      `UPDATE tournament_stages
       SET match_options_id = clone_match_options(
         (SELECT match_options_id FROM tournaments WHERE id = $1)
       )
       WHERE id = $2`,
      [tournament.id, tournament.stageIds[0]],
    );
    return tournament;
  };

  const openRegistration = async (tournament: Tournament) => {
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }
  };

  const drawnTournament = async () => {
    const tournament = await tournamentWithStageOptions();
    await openRegistration(tournament);
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
    return tournament;
  };

  // A new Custom pool holding the tournament pool's maps, or all but `without`
  // of them.
  const copyPool = async (tournamentId: string, { without = 0 } = {}) => {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    await postgres.query(
      `INSERT INTO _map_pool (map_pool_id, map_id)
       SELECT $1, mp.map_id
       FROM tournaments t
       INNER JOIN match_options mo ON mo.id = t.match_options_id
       INNER JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
       WHERE t.id = $2
       ORDER BY mp.map_id
       OFFSET $3`,
      [pool.id, tournamentId, without],
    );
    return pool.id;
  };

  const setTournamentPool = (tournamentId: string, poolId: string) =>
    postgres.query(
      `UPDATE match_options SET map_pool_id = $2
       WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [tournamentId, poolId],
    );

  const setStagePool = (stageId: string, poolId: string) =>
    postgres.query(
      `UPDATE match_options SET map_pool_id = $2
       WHERE id = (SELECT match_options_id FROM tournament_stages WHERE id = $1)`,
      [stageId, poolId],
    );

  const tournamentOptions = async (tournamentId: string) => {
    const [template] = await postgres.query<Array<Options>>(
      `SELECT mo.id, mo.map_pool_id, mo.tv_delay
       FROM tournaments t
       INNER JOIN match_options mo ON mo.id = t.match_options_id
       WHERE t.id = $1`,
      [tournamentId],
    );
    const stages = await postgres.query<Array<Options>>(
      `SELECT mo.id, mo.map_pool_id, mo.tv_delay
       FROM tournament_stages ts
       INNER JOIN match_options mo ON mo.id = ts.match_options_id
       WHERE ts.tournament_id = $1
       ORDER BY ts."order"`,
      [tournamentId],
    );
    const matches = await postgres.query<Array<Options>>(
      `SELECT mo.id, mo.map_pool_id, mo.tv_delay
       FROM tournament_stages ts
       INNER JOIN tournament_brackets tb ON tb.tournament_stage_id = ts.id
       INNER JOIN matches m ON m.id = tb.match_id
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       WHERE ts.tournament_id = $1
       ORDER BY ts."order", tb.round, tb.match_number`,
      [tournamentId],
    );
    return { template, stages, matches };
  };

  // Settles the edit first so a run that lets the pool through reports where
  // it ended up, not just the missing refusal.
  const attempt = async (edit: Promise<unknown>): Promise<Error | null> => {
    try {
      await edit;
      return null;
    } catch (error) {
      return error as Error;
    }
  };

  describe("with the bracket drawn", () => {
    it("refuses a pool of different maps and leaves the tournament, its stages and its matches on theirs", async () => {
      const tournament = await drawnTournament();
      const before = await tournamentOptions(tournament.id);
      expect(before.stages.length).toBe(1);
      expect(before.matches.length).toBe(2);

      const error = await attempt(
        setTournamentPool(
          tournament.id,
          await copyPool(tournament.id, { without: 1 }),
        ),
      );

      expect(await tournamentOptions(tournament.id)).toEqual(before);
      expect(error?.message).toMatch(REFUSAL);
    });

    it("refuses a pool of different maps on a stage's own options", async () => {
      const tournament = await drawnTournament();
      const before = await tournamentOptions(tournament.id);

      const error = await attempt(
        setStagePool(
          tournament.stageIds[0],
          await copyPool(tournament.id, { without: 1 }),
        ),
      );

      expect(await tournamentOptions(tournament.id)).toEqual(before);
      expect(error?.message).toMatch(REFUSAL);
    });

    it("refuses it while registration is still open once the bracket holds teams", async () => {
      const tournament = await tournamentWithStageOptions();
      await openRegistration(tournament);
      await postgres.query(
        "SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1",
        [tournament.id],
      );
      await postgres.query("SELECT seed_stage($1)", [tournament.stageIds[0]]);
      const before = await tournamentOptions(tournament.id);

      const error = await attempt(
        setTournamentPool(
          tournament.id,
          await copyPool(tournament.id, { without: 1 }),
        ),
      );

      expect(await tournamentOptions(tournament.id)).toEqual(before);
      expect(error?.message).toMatch(REFUSAL);
    });

    it("keeps its pool when a save brings a new Custom pool of the same maps, and still carries the save's other settings", async () => {
      const tournament = await drawnTournament();
      const before = await tournamentOptions(tournament.id);
      expect(before.template.tv_delay).not.toBe(90);

      await postgres.query(
        `UPDATE match_options SET tv_delay = 90, map_pool_id = $2
         WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [tournament.id, await copyPool(tournament.id)],
      );

      const saved = { map_pool_id: before.template.map_pool_id, tv_delay: 90 };
      expect(await tournamentOptions(tournament.id)).toMatchObject({
        template: saved,
        stages: [saved],
        matches: [saved, saved],
      });
    });

    it("still carries a region change to the matches that have not started", async () => {
      const tournament = await drawnTournament();

      await postgres.query(
        `UPDATE match_options SET regions = '{TestB}', region_veto = false
         WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [tournament.id],
      );

      const matches = await postgres.query<
        Array<{ regions: Array<string>; region: string | null }>
      >(
        `SELECT mo.regions, m.region
         FROM tournament_brackets tb
         INNER JOIN matches m ON m.id = tb.match_id
         INNER JOIN match_options mo ON mo.id = m.match_options_id
         WHERE tb.tournament_stage_id = $1`,
        [tournament.stageIds[0]],
      );
      expect(matches).toEqual([
        { regions: ["TestB"], region: "TestB" },
        { regions: ["TestB"], region: "TestB" },
      ]);
    });

    it("still lets one match that has not started be given another pool", async () => {
      const tournament = await drawnTournament();
      const before = await tournamentOptions(tournament.id);
      const other = await copyPool(tournament.id, { without: 1 });

      await postgres.query(
        "UPDATE match_options SET map_pool_id = $1 WHERE id = $2",
        [other, before.matches[0].id],
      );

      const after = await tournamentOptions(tournament.id);
      expect(after.matches.map((match) => match.map_pool_id)).toEqual([
        other,
        before.template.map_pool_id,
      ]);
      expect(after.template).toEqual(before.template);
      expect(after.stages).toEqual(before.stages);
    });
  });

  describe("before the draw", () => {
    it("takes a new pool in Setup and carries it to the stages", async () => {
      const tournament = await tournamentWithStageOptions();
      const other = await copyPool(tournament.id, { without: 1 });

      await setTournamentPool(tournament.id, other);

      expect(await tournamentOptions(tournament.id)).toMatchObject({
        template: { map_pool_id: other },
        stages: [{ map_pool_id: other }],
        matches: [],
      });
    });

    it("takes a new pool while registration is open and no bracket holds a team", async () => {
      const tournament = await tournamentWithStageOptions();
      await openRegistration(tournament);
      const other = await copyPool(tournament.id, { without: 1 });

      await setTournamentPool(tournament.id, other);

      expect(await tournamentOptions(tournament.id)).toMatchObject({
        template: { map_pool_id: other },
        stages: [{ map_pool_id: other }],
        matches: [],
      });
    });
  });
});
