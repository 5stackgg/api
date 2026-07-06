import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the match_options triggers: the tbu_match_options edit locks
// (finished matches, invite codes, Live/Veto field freezes) and the
// tau_match_options / tad_match_options map-resync and custom-pool cleanup.
describe("match options locks (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchOptionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    // Two regions: with a single one, tbi_match_options force-disables
    // region_veto and the freeze assertions would test a no-op.
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27016);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM map_pools WHERE type = 'Custom'");
  });

  const createPool = async (offset = 0) => {
    const { poolId, mapIds } = await fx.mapPool(1, { offset });
    return { poolId, mapId: mapIds[0] };
  };

  const createMatch = async () => {
    const { poolId, mapId } = await createPool(0);
    const match = await fx.match({ mapPoolId: poolId });
    return { matchId: match.id, optionsId: match.options_id, poolId, mapId };
  };

  const setMatchStatus = (matchId: string, status: string) =>
    postgres.query("UPDATE matches SET status = $1 WHERE id = $2", [
      status,
      matchId,
    ]);

  const updateOptions = (optionsId: string, set: string) =>
    postgres.query(`UPDATE match_options SET ${set} WHERE id = $1`, [
      optionsId,
    ]);

  it("locks all option edits once the match is finished", async () => {
    const { matchId, optionsId } = await createMatch();
    await setMatchStatus(matchId, "Live");
    await postgres.query(
      "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
      [matchId],
    );

    await expect(updateOptions(optionsId, "knife_round = false")).rejects.toThrow(
      /after match is finished/i,
    );
  });

  it("locks the invite code outside of PickingPlayers", async () => {
    const { matchId, optionsId } = await createMatch();

    await updateOptions(optionsId, "invite_code = '123456'");

    await setMatchStatus(matchId, "Live");
    await expect(
      updateOptions(optionsId, "invite_code = '654321'"),
    ).rejects.toThrow(/Cannot modify invite code/i);
  });

  it("freezes structural fields during Live", async () => {
    const { matchId, optionsId } = await createMatch();
    await setMatchStatus(matchId, "Live");

    await expect(updateOptions(optionsId, "best_of = 3")).rejects.toThrow(
      /Cannot modify best of/i,
    );
    await expect(updateOptions(optionsId, "map_veto = true")).rejects.toThrow(
      /Cannot modify map veto/i,
    );
    await expect(
      updateOptions(optionsId, "type = 'Wingman'"),
    ).rejects.toThrow(/Cannot modify match type/i);
    await expect(
      updateOptions(optionsId, "region_veto = false"),
    ).rejects.toThrow(/Cannot modify region veto/i);
    await expect(updateOptions(optionsId, "mr = 15")).rejects.toThrow(
      /Cannot modify mr/i,
    );

    const { poolId: otherPool } = await createPool(1);
    await expect(
      postgres.query(
        "UPDATE match_options SET map_pool_id = $1 WHERE id = $2",
        [otherPool, optionsId],
      ),
    ).rejects.toThrow(/Cannot modify map pool/i);
  });

  it("still allows cosmetic edits during Live", async () => {
    const { matchId, optionsId } = await createMatch();
    await setMatchStatus(matchId, "Live");

    await updateOptions(optionsId, "coaches = true");

    const [row] = await postgres.query<Array<{ coaches: boolean }>>(
      "SELECT coaches FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(row.coaches).toBe(true);
  });

  it("swapping the map pool before the match re-syncs its maps", async () => {
    const { matchId, optionsId, mapId } = await createMatch();

    const [before] = await postgres.query<Array<{ map_id: string }>>(
      "SELECT map_id FROM match_maps WHERE match_id = $1",
      [matchId],
    );
    expect(before.map_id).toBe(mapId);

    const { poolId: otherPool, mapId: otherMap } = await createPool(1);
    await postgres.query(
      "UPDATE match_options SET map_pool_id = $1 WHERE id = $2",
      [otherPool, optionsId],
    );

    const after = await postgres.query<Array<{ map_id: string }>>(
      "SELECT map_id FROM match_maps WHERE match_id = $1",
      [matchId],
    );
    expect(after.length).toBe(1);
    expect(after[0].map_id).toBe(otherMap);
  });

  it("deleting the match garbage-collects its options and their custom pool", async () => {
    const { matchId, optionsId, poolId } = await createMatch();

    await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

    const options = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(options.length).toBe(0);

    const pools = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM map_pools WHERE id = $1",
      [poolId],
    );
    expect(pools.length).toBe(0);
  });
});
