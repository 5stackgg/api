import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the ELO engine (generate_player_elo_for_match /
// get_player_elo_for_match): the 5000 baseline, rating chaining across
// matches, series-differential scaling, recompute idempotency, the
// source/winner guards, per-season ladder isolation, the tournament track,
// and the loss-protection transform for strong performers on losing teams.
describe("ELO engine (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("EloTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199500000000n);
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
    await postgres.query("DELETE FROM seasons");
    await postgres.query(
      "DELETE FROM settings WHERE name = 'public.seasons_enabled'",
    );
  });

  // A finished 1v1: Duel needs one player per lineup, keeping team averages
  // equal to the player's own rating.
  const duel = async (
    playerA: string,
    playerB: string,
    {
      winner = "a",
      endedDaysAgo = 1,
      bestOf = 1,
    }: { winner?: "a" | "b"; endedDaysAgo?: number; bestOf?: number } = {},
  ) => {
    const match = await fx.match({
      type: "Duel",
      bestOf,
      mapPoolId:
        bestOf > 1 ? (await fx.mapPool(bestOf)).poolId : undefined,
    });
    await fx.lineupPlayer(match.lineup_1_id, playerA);
    await fx.lineupPlayer(match.lineup_2_id, playerB);
    await postgres.query(
      `UPDATE matches SET winning_lineup_id = ${
        winner === "a" ? "lineup_1_id" : "lineup_2_id"
      } WHERE id = $1`,
      [match.id],
    );
    await postgres.query(
      `UPDATE matches SET ended_at = now() - make_interval(days => $2) WHERE id = $1`,
      [match.id, endedDaysAgo],
    );
    return match;
  };

  const generate = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{ generate_player_elo_for_match: number }>
    >("SELECT generate_player_elo_for_match($1)", [matchId]);
    return Number(row.generate_player_elo_for_match);
  };

  type EloRow = {
    steam_id: string;
    current: number;
    change: number;
    actual_score: number;
    expected_score: number;
    series_multiplier: number;
    performance_multiplier: number;
    season_id: string | null;
  };

  const eloRows = (matchId: string) =>
    postgres.query<Array<EloRow>>(
      `SELECT steam_id, current, change, actual_score, expected_score,
              series_multiplier, performance_multiplier, season_id
       FROM player_elo WHERE match_id = $1 ORDER BY steam_id`,
      [matchId],
    );

  it("rates both players off the 5000 baseline with symmetric expectations", async () => {
    const [a, b] = await fx.players(2);
    const match = await duel(a, b);

    expect(await generate(match.id)).toBe(2);

    const rows = await eloRows(match.id);
    const winner = rows.find((r) => r.steam_id === a)!;
    const loser = rows.find((r) => r.steam_id === b)!;

    expect(winner.expected_score).toBeCloseTo(0.5);
    expect(loser.expected_score).toBeCloseTo(0.5);
    expect(Number(winner.change)).toBeGreaterThan(0);
    expect(Number(loser.change)).toBeLessThan(0);
    expect(Number(winner.current)).toBe(5000 + Number(winner.change));
    expect(Number(loser.current)).toBe(5000 + Number(loser.change));
  });

  it("chains each match off the previous rating", async () => {
    const [a, b] = await fx.players(2);
    const first = await duel(a, b, { endedDaysAgo: 3 });
    await generate(first.id);
    const [firstWinner] = (await eloRows(first.id)).filter(
      (r) => r.steam_id === a,
    );

    const second = await duel(a, b, { endedDaysAgo: 2 });
    await generate(second.id);
    const [secondWinner] = (await eloRows(second.id)).filter(
      (r) => r.steam_id === a,
    );

    expect(Number(secondWinner.current)).toBe(
      Number(firstWinner.current) + Number(secondWinner.change),
    );
    // The higher-rated player is now expected to win.
    expect(secondWinner.expected_score).toBeGreaterThan(0.5);
  });

  it("scales the change by the series map differential", async () => {
    const [a, b] = await fx.players(2);
    const sweep = await duel(a, b, { bestOf: 3, endedDaysAgo: 4 });
    // 2-0 sweep: both decided maps to lineup 1.
    await postgres.query(
      `UPDATE match_maps SET winning_lineup_id = $2
       WHERE match_id = $1 AND "order" <= 2`,
      [sweep.id, sweep.lineup_1_id],
    );
    await generate(sweep.id);
    const sweepRows = await eloRows(sweep.id);
    expect(
      sweepRows.every((r) => Number(r.series_multiplier) === 2),
    ).toBe(true);

    const [c, d] = await fx.players(2);
    const close = await duel(c, d, { bestOf: 3, endedDaysAgo: 3 });
    await postgres.query(
      `UPDATE match_maps SET winning_lineup_id = $2 WHERE match_id = $1 AND "order" <= 2`,
      [close.id, close.lineup_1_id],
    );
    await postgres.query(
      `UPDATE match_maps SET winning_lineup_id = $2 WHERE match_id = $1 AND "order" = 3`,
      [close.id, close.lineup_2_id],
    );
    await generate(close.id);
    const closeRows = await eloRows(close.id);
    expect(
      closeRows.every((r) => Number(r.series_multiplier) === 1),
    ).toBe(true);

    // Same baseline, same outcome — the sweep moves ratings further.
    const sweepWinner = sweepRows.find((r) => r.steam_id === a)!;
    const closeWinner = closeRows.find((r) => r.steam_id === c)!;
    expect(Number(sweepWinner.change)).toBeGreaterThan(
      Number(closeWinner.change),
    );
  });

  it("recomputes idempotently: one row set per player per match", async () => {
    const [a, b] = await fx.players(2);
    const match = await duel(a, b);

    await generate(match.id);
    const firstRun = await eloRows(match.id);
    await generate(match.id);
    const secondRun = await eloRows(match.id);

    expect(secondRun.length).toBe(2);
    expect(secondRun).toEqual(firstRun);
  });

  it("skips external and undecided matches", async () => {
    const [a, b] = await fx.players(2);

    const undecided = await fx.match({ type: "Duel" });
    await fx.lineupPlayer(undecided.lineup_1_id, a);
    await fx.lineupPlayer(undecided.lineup_2_id, b);
    expect(await generate(undecided.id)).toBe(0);

    const external = await duel(a, b);
    await postgres.query("UPDATE matches SET source = 'faceit' WHERE id = $1", [
      external.id,
    ]);
    expect(await generate(external.id)).toBe(0);
    expect((await eloRows(external.id)).length).toBe(0);
  });

  it("keeps each season's ladder independent", async () => {
    await fx.enableSeasons();
    const seasonOne = await fx.season("2025-01-01", "2025-03-01");
    const seasonTwo = await fx.season("2025-03-01", "2025-06-01");
    const [a, b] = await fx.players(2);

    const inSeasonOne = await duel(a, b);
    await postgres.query(
      "UPDATE matches SET ended_at = '2025-02-01' WHERE id = $1",
      [inSeasonOne.id],
    );
    await generate(inSeasonOne.id);

    const inSeasonTwo = await duel(a, b);
    await postgres.query(
      "UPDATE matches SET ended_at = '2025-04-01' WHERE id = $1",
      [inSeasonTwo.id],
    );
    await generate(inSeasonTwo.id);

    const seasonOneRows = await eloRows(inSeasonOne.id);
    const seasonTwoRows = await eloRows(inSeasonTwo.id);

    expect(seasonOneRows.every((r) => r.season_id === seasonOne)).toBe(true);
    expect(seasonTwoRows.every((r) => r.season_id === seasonTwo)).toBe(true);

    // The new season starts from the baseline again, not from season one's ladder.
    const winnerTwo = seasonTwoRows.find((r) => r.steam_id === a)!;
    expect(Number(winnerTwo.current)).toBe(5000 + Number(winnerTwo.change));
    expect(winnerTwo.expected_score).toBeCloseTo(0.5);
  });

  it("rates tournament matches on their own season-independent track", async () => {
    await fx.enableSeasons();
    await fx.season("2025-01-01", null);

    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const semi = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;
    await tfx.winMatch(semi.match_id!);

    expect(await generate(semi.match_id!)).toBeGreaterThan(0);
    const rows = await postgres.query<Array<{ season_id: string | null }>>(
      "SELECT season_id FROM player_elo WHERE match_id = $1",
      [semi.match_id],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.season_id === null)).toBe(true);
  });

  it("protects strong performers on losing teams", async () => {
    // Two identical 1v1 losses; in the second, the loser at least got kills
    // and damage in. The loss-transform maps better impact to a smaller cut.
    const [a, b] = await fx.players(2);
    const silent = await duel(a, b, { endedDaysAgo: 4 });
    await generate(silent.id);
    const silentLoser = (await eloRows(silent.id)).find(
      (r) => r.steam_id === b,
    )!;

    const [c, d] = await fx.players(2);
    const fought = await duel(c, d, { endedDaysAgo: 3 });
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [fought.id],
    );
    const ctx = { matchId: fought.id, mapId: map.id };
    await fx.kill(ctx, d, c, { time: new Date().toISOString() });
    await fx.damage(ctx, d, c, 100);
    await generate(fought.id);
    const fightingLoser = (await eloRows(fought.id)).find(
      (r) => r.steam_id === d,
    )!;

    expect(fightingLoser.performance_multiplier).toBeLessThan(
      silentLoser.performance_multiplier,
    );
    expect(Math.abs(Number(fightingLoser.change))).toBeLessThan(
      Math.abs(Number(silentLoser.change)),
    );
  });
});
