import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the round -> map -> match progression SQL: lineup_1/2_score read
// the latest round snapshot, tau_match_maps drives update_match_state, and a
// finished map only finishes the match once a lineup owns the series.
describe("match scoring from rounds (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchScoringTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
  });

  // A Live best-of-N match whose maps are materialized from an exactly-sized
  // custom pool (pool == best_of skips both vetoes).
  const createLiveMatch = async (bestOf: number) => {
    const { poolId } = await fx.mapPool(bestOf);
    const match = await fx.match({ bestOf, mapPoolId: poolId });
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    const maps = await postgres.query<Array<{ id: string }>>(
      'SELECT id FROM match_maps WHERE match_id = $1 ORDER BY "order"',
      [match.id],
    );
    return { ...match, mapIds: maps.map((m) => m.id) };
  };

  const recordScore = (mapId: string, s1: number, s2: number) =>
    fx.roundScore(mapId, s1, s2);

  const finishMap = (mapId: string) => fx.finishMap(mapId);

  const matchRow = async (id: string) => {
    const [row] = await postgres.query<
      Array<{
        status: string;
        winning_lineup_id: string | null;
        ended_at: Date | null;
      }>
    >("SELECT status, winning_lineup_id, ended_at FROM matches WHERE id = $1", [
      id,
    ]);
    return row;
  };

  it("finishing a BO1 map finishes the match for the higher-scoring lineup", async () => {
    const match = await createLiveMatch(1);
    await recordScore(match.mapIds[0], 13, 7);

    await finishMap(match.mapIds[0]);

    const after = await matchRow(match.id);
    expect(after.status).toBe("Finished");
    expect(after.winning_lineup_id).toBe(match.lineup_1_id);
    expect(after.ended_at).not.toBeNull();
  });

  it("uses the latest round snapshot as the score", async () => {
    const match = await createLiveMatch(1);
    // The early snapshot has lineup 1 ahead; the final one flips it.
    await recordScore(match.mapIds[0], 7, 13);

    const [scores] = await postgres.query<
      Array<{ s1: number; s2: number }>
    >(
      "SELECT lineup_1_score(mm) AS s1, lineup_2_score(mm) AS s2 FROM match_maps mm WHERE id = $1",
      [match.mapIds[0]],
    );
    expect(Number(scores.s1)).toBe(7);
    expect(Number(scores.s2)).toBe(13);

    await finishMap(match.mapIds[0]);
    expect((await matchRow(match.id)).winning_lineup_id).toBe(
      match.lineup_2_id,
    );
  });

  it("a tied map decides nothing: the match stays Live", async () => {
    const match = await createLiveMatch(1);
    await recordScore(match.mapIds[0], 12, 12);

    await finishMap(match.mapIds[0]);

    const after = await matchRow(match.id);
    expect(after.status).toBe("Live");
    expect(after.winning_lineup_id).toBeNull();
  });

  it("a BO3 needs two map wins before the match finishes", async () => {
    const match = await createLiveMatch(3);

    await recordScore(match.mapIds[0], 13, 7);
    await finishMap(match.mapIds[0]);
    expect((await matchRow(match.id)).status).toBe("Live");

    await recordScore(match.mapIds[1], 5, 13);
    await finishMap(match.mapIds[1]);
    expect((await matchRow(match.id)).status).toBe("Live");

    await recordScore(match.mapIds[2], 13, 11);
    await finishMap(match.mapIds[2]);

    const after = await matchRow(match.id);
    expect(after.status).toBe("Finished");
    expect(after.winning_lineup_id).toBe(match.lineup_1_id);
  });

  it("does not overwrite a forfeited match", async () => {
    const match = await createLiveMatch(1);
    await recordScore(match.mapIds[0], 13, 7);

    await postgres.query("UPDATE matches SET status = 'Forfeit' WHERE id = $1", [
      match.id,
    ]);
    await finishMap(match.mapIds[0]);

    const after = await matchRow(match.id);
    expect(after.status).toBe("Forfeit");
    expect(after.winning_lineup_id).toBeNull();
  });

  it("a map going Live stamps started_at and arms the live-match timeout", async () => {
    const match = await createLiveMatch(1);

    await postgres.query("UPDATE match_maps SET status = 'Live' WHERE id = $1", [
      match.mapIds[0],
    ]);

    const [map] = await postgres.query<Array<{ started_at: Date | null }>>(
      "SELECT started_at FROM match_maps WHERE id = $1",
      [match.mapIds[0]],
    );
    expect(map.started_at).not.toBeNull();

    const [live] = await postgres.query<Array<{ cancels_at: Date | null }>>(
      "SELECT cancels_at FROM matches WHERE id = $1",
      [match.id],
    );
    // Default live_match_timeout is 180 minutes.
    expect(live.cancels_at).not.toBeNull();
    const minutesOut = (live.cancels_at!.getTime() - Date.now()) / 60_000;
    expect(minutesOut).toBeGreaterThan(170);
    expect(minutesOut).toBeLessThan(190);

    // Pausing the map disarms the timeout.
    await postgres.query(
      "UPDATE match_maps SET status = 'Paused' WHERE id = $1",
      [match.mapIds[0]],
    );
    const [paused] = await postgres.query<Array<{ cancels_at: Date | null }>>(
      "SELECT cancels_at FROM matches WHERE id = $1",
      [match.id],
    );
    expect(paused.cancels_at).toBeNull();
  });

  it("finishing the map stamps the map's ended_at", async () => {
    const match = await createLiveMatch(1);
    await recordScore(match.mapIds[0], 13, 7);
    await finishMap(match.mapIds[0]);

    const [map] = await postgres.query<Array<{ ended_at: Date | null }>>(
      "SELECT ended_at FROM match_maps WHERE id = $1",
      [match.mapIds[0]],
    );
    expect(map.ended_at).not.toBeNull();
  });
});
