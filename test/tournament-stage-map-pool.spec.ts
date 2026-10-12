import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A seeded map pool is one row every option set shares, so a stage that chose
// the tournament's own pool holds the same id as a stage that merely inherited
// it. Only map_pool_explicit tells the two apart when the tournament's pool
// changes.
describe("a stage's map pool when the tournament's changes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentStageMapPoolTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199630000000n);
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

  // What TournamentStageForm writes for a stage with its own settings: a copy
  // of the tournament's options, here with a tv_delay of its own.
  const giveStageOwnOptions = async (
    tournamentId: string,
    stageId: string,
    mapPoolExplicit: boolean,
  ) => {
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, tv_delay, map_pool_explicit)
       SELECT mr, best_of, type, map_pool_id, map_veto, region_veto, regions, 90, $2
       FROM match_options
       WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)
       RETURNING id`,
      [tournamentId, mapPoolExplicit],
    );
    await postgres.query(
      "UPDATE tournament_stages SET match_options_id = $1 WHERE id = $2",
      [options.id, stageId],
    );
    return options.id;
  };

  const wingmanPool = async (offset: number) =>
    (await fx.mapPool(3, { mapType: "Wingman", offset })).poolId;

  const setPool = (optionsId: string, poolId: string) =>
    postgres.query("UPDATE match_options SET map_pool_id = $2 WHERE id = $1", [
      optionsId,
      poolId,
    ]);

  const tournamentOptions = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ match_options_id: string }>>(
      "SELECT match_options_id FROM tournaments WHERE id = $1",
      [tournamentId],
    );
    return row.match_options_id;
  };

  const poolOf = async (optionsId: string) => {
    const [row] = await postgres.query<
      Array<{ map_pool_id: string; map_pool_explicit: boolean }>
    >(
      "SELECT map_pool_id, map_pool_explicit FROM match_options WHERE id = $1",
      [optionsId],
    );
    return row;
  };

  const drawnMatchPools = async (stageId: string) =>
    (
      await postgres.query<Array<{ map_pool_id: string }>>(
        `SELECT mo.map_pool_id
         FROM tournament_brackets tb
         INNER JOIN matches m ON m.id = tb.match_id
         INNER JOIN match_options mo ON mo.id = m.match_options_id
         WHERE tb.tournament_stage_id = $1 AND tb.round = 1
         ORDER BY tb.match_number`,
        [stageId],
      )
    ).map((row) => row.map_pool_id);

  const closeRegistration = async (tournament: {
    id: string;
    organizer: string;
  }) => {
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
  };

  it("keeps a stage, and its drawn matches, on the pool it chose when that was the tournament's", async () => {
    const tournament = await tfx.createTournament(SE4);
    const [stageId] = tournament.stageIds;
    const activeDuty = await fx.seededPool("Wingman");
    const stageOptions = await giveStageOwnOptions(
      tournament.id,
      stageId,
      true,
    );
    await closeRegistration(tournament);

    await setPool(await tournamentOptions(tournament.id), await wingmanPool(0));

    expect(await poolOf(stageOptions)).toEqual({
      map_pool_id: activeDuty,
      map_pool_explicit: true,
    });
    expect(await drawnMatchPools(stageId)).toEqual([activeDuty, activeDuty]);
  });

  it("moves a stage that only inherited the pool, and its drawn matches, with the tournament", async () => {
    const tournament = await tfx.createTournament(SE4);
    const [stageId] = tournament.stageIds;
    const stageOptions = await giveStageOwnOptions(
      tournament.id,
      stageId,
      false,
    );
    await closeRegistration(tournament);

    const next = await wingmanPool(0);
    await setPool(await tournamentOptions(tournament.id), next);

    expect(await poolOf(stageOptions)).toEqual({
      map_pool_id: next,
      map_pool_explicit: false,
    });
    expect(await drawnMatchPools(stageId)).toEqual([next, next]);
  });

  it("never hands the tournament's own marker down to an inheriting stage", async () => {
    const tournament = await tfx.createTournament(SE4);
    const [stageId] = tournament.stageIds;
    const stageOptions = await giveStageOwnOptions(
      tournament.id,
      stageId,
      false,
    );
    const options = await tournamentOptions(tournament.id);

    await postgres.query(
      "UPDATE match_options SET map_pool_explicit = true WHERE id = $1",
      [options],
    );
    const next = await wingmanPool(0);
    await setPool(options, next);

    expect(await poolOf(stageOptions)).toEqual({
      map_pool_explicit: false,
      map_pool_id: next,
    });
  });

  it("still moves an explicit stage's drawn matches when the stage itself changes pool", async () => {
    const tournament = await tfx.createTournament(SE4);
    const [stageId] = tournament.stageIds;
    const stageOptions = await giveStageOwnOptions(
      tournament.id,
      stageId,
      true,
    );
    await closeRegistration(tournament);

    const next = await wingmanPool(1);
    await setPool(stageOptions, next);

    expect(await drawnMatchPools(stageId)).toEqual([next, next]);
  });
});
