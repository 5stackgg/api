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
    // Unlink first: cascading tournaments -> brackets fires triggers that also
    // touch the linked match, which trips "tuple to be deleted was already
    // modified" once both sides go in one command.
    await postgres.query("UPDATE tournament_brackets SET match_id = NULL");
    await postgres.query("DELETE FROM tournaments");
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

    const [scores] = await postgres.query<Array<{ s1: number; s2: number }>>(
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

  // Regression: auto-generated clips for map 1's demo land while map 2 is in
  // play. The match_clips insert bumps clips_count on the Finished map-1 row,
  // which used to re-run update_match_state against map 2's live round
  // snapshot and finish the whole series for whoever was momentarily ahead.
  it("a clip landing on a finished map mid-series does not end the match early", async () => {
    const match = await createLiveMatch(3);

    await recordScore(match.mapIds[0], 5, 13);
    await finishMap(match.mapIds[0]);
    expect((await matchRow(match.id)).status).toBe("Live");

    const [{ ended_at: map1EndedAt }] = await postgres.query<
      Array<{ ended_at: Date }>
    >("SELECT ended_at FROM match_maps WHERE id = $1", [match.mapIds[0]]);

    await postgres.query(
      "UPDATE match_maps SET status = 'Live' WHERE id = $1",
      [match.mapIds[1]],
    );
    await fx.round(match.mapIds[1], 1, {
      l1Score: 0,
      l2Score: 1,
      time: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    await fx.round(match.mapIds[1], 2, {
      l1Score: 0,
      l2Score: 2,
      time: new Date(Date.now() - 25 * 60_000).toISOString(),
    });

    const owner = await fx.player();
    await postgres.query(
      `INSERT INTO match_clips (user_steam_id, match_map_id, title, visibility)
       VALUES ($1, $2, 'clip', 'private')`,
      [owner, match.mapIds[0]],
    );

    const after = await matchRow(match.id);
    expect(after.status).toBe("Live");
    expect(after.winning_lineup_id).toBeNull();

    const [{ ended_at: map1EndedAtAfter }] = await postgres.query<
      Array<{ ended_at: Date }>
    >("SELECT ended_at FROM match_maps WHERE id = $1", [match.mapIds[0]]);
    expect(map1EndedAtAfter.getTime()).toBe(map1EndedAt.getTime());

    await fx.round(match.mapIds[1], 3, { l1Score: 13, l2Score: 9 });
    await finishMap(match.mapIds[1]);
    expect((await matchRow(match.id)).status).toBe("Live");

    await recordScore(match.mapIds[2], 13, 5);
    await finishMap(match.mapIds[2]);

    const done = await matchRow(match.id);
    expect(done.status).toBe("Finished");
    expect(done.winning_lineup_id).toBe(match.lineup_1_id);
  });

  it("non-status updates on a live map do not re-stamp started_at", async () => {
    const match = await createLiveMatch(1);

    await postgres.query(
      "UPDATE match_maps SET status = 'Live' WHERE id = $1",
      [match.mapIds[0]],
    );
    await postgres.query(
      "UPDATE match_maps SET started_at = now() - interval '10 minutes' WHERE id = $1",
      [match.mapIds[0]],
    );
    const [{ started_at: before }] = await postgres.query<
      Array<{ started_at: Date }>
    >("SELECT started_at FROM match_maps WHERE id = $1", [match.mapIds[0]]);

    await postgres.query(
      "UPDATE match_maps SET lineup_1_timeouts_available = 2 WHERE id = $1",
      [match.mapIds[0]],
    );
    const [{ started_at: after }] = await postgres.query<
      Array<{ started_at: Date }>
    >("SELECT started_at FROM match_maps WHERE id = $1", [match.mapIds[0]]);
    expect(after.getTime()).toBe(before.getTime());
  });

  // Attaches the match to a double-elimination bracket row shaped like the
  // generator's grand final: path 'WB', no parent, an LB feeder as a child.
  // withLbFeeder=false models a parentless WB *final* in a stage that passes
  // 2+ teams on (no grand final generated), which must NOT get the advantage.
  const linkDoubleElimFinal = async (
    matchId: string,
    advantage: number,
    { withLbFeeder = true } = {},
  ) => {
    const organizer = await fx.player();
    const [{ match_options_id }] = await postgres.query<
      Array<{ match_options_id: string }>
    >("SELECT match_options_id FROM matches WHERE id = $1", [matchId]);
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now(), $2, $3, 'Setup') RETURNING id`,
      [fx.nextName("de-cup"), organizer, match_options_id],
    );
    const [stage] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams, final_map_advantage)
       VALUES ($1, 'DoubleElimination', 1, 4, 8, $2) RETURNING id`,
      [tournament.id, advantage],
    );
    const [finalBracket] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, path, match_id)
       VALUES ($1, 3, 1, 'WB', $2) RETURNING id`,
      [stage.id, matchId],
    );
    if (withLbFeeder) {
      await postgres.query(
        `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, path, parent_bracket_id)
         VALUES ($1, 2, 1, 'LB', $2)`,
        [stage.id, finalBracket.id],
      );
    }
  };

  it("grand final: the winner-bracket team banks final_map_advantage map wins", async () => {
    const match = await createLiveMatch(3);
    await linkDoubleElimFinal(match.id, 1);

    await recordScore(match.mapIds[0], 13, 7);
    await finishMap(match.mapIds[0]);

    const after = await matchRow(match.id);
    expect(after.status).toBe("Finished");
    expect(after.winning_lineup_id).toBe(match.lineup_1_id);
  });

  it("a parentless WB final without a grand final gets no advantage", async () => {
    const match = await createLiveMatch(3);
    await linkDoubleElimFinal(match.id, 1, { withLbFeeder: false });

    await recordScore(match.mapIds[0], 13, 7);
    await finishMap(match.mapIds[0]);

    expect((await matchRow(match.id)).status).toBe("Live");
  });

  it("an over-sized advantage is clamped below the win threshold", async () => {
    const match = await createLiveMatch(3);
    await linkDoubleElimFinal(match.id, 2);

    // Unclamped, advantage 2 in a Bo3 would finish the series for lineup 1
    // here despite lineup 2 winning the map.
    await recordScore(match.mapIds[0], 7, 13);
    await finishMap(match.mapIds[0]);
    expect((await matchRow(match.id)).status).toBe("Live");

    await recordScore(match.mapIds[1], 5, 13);
    await finishMap(match.mapIds[1]);

    const after = await matchRow(match.id);
    expect(after.status).toBe("Finished");
    expect(after.winning_lineup_id).toBe(match.lineup_2_id);
  });

  it("does not overwrite a forfeited match", async () => {
    const match = await createLiveMatch(1);
    await recordScore(match.mapIds[0], 13, 7);

    await postgres.query(
      "UPDATE matches SET status = 'Forfeit' WHERE id = $1",
      [match.id],
    );
    await finishMap(match.mapIds[0]);

    const after = await matchRow(match.id);
    expect(after.status).toBe("Forfeit");
    expect(after.winning_lineup_id).toBeNull();
  });

  it("a map going Live stamps started_at and arms the live-match timeout", async () => {
    const match = await createLiveMatch(1);

    await postgres.query(
      "UPDATE match_maps SET status = 'Live' WHERE id = $1",
      [match.mapIds[0]],
    );

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
