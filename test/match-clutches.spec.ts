import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Pins every clutch v_match_clutches reports for a map of mixed endgames, and
// that detect_round_clutch agrees with it round by round, so how the kill feed
// is walked can change without a clutch changing.
describe("match clutches", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let players: Record<string, string>;
  let ctx: { matchId: string; mapId: string };
  let lineups: { a: string; b: string };

  const T = (secondsAgo: number) =>
    new Date(Date.now() - 3_600_000 - secondsAgo * 1000).toISOString();

  beforeAll(async () => {
    db = await bootMigratedDb("MatchClutchesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199780000000n);
    await fx.region();

    const match = await fx.match({ type: "Competitive" });
    const [a1, a2, a3, b1, b2, b3, stranger] = await fx.players(7);
    players = { a1, a2, a3, b1, b2, b3, stranger };
    for (const p of [a1, a2, a3]) await fx.lineupPlayer(match.lineup_1_id, p);
    for (const p of [b1, b2, b3]) await fx.lineupPlayer(match.lineup_2_id, p);
    lineups = { a: match.lineup_1_id, b: match.lineup_2_id };
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [match.id],
    );
    ctx = { matchId: match.id, mapId: map.id };

    // Lineup 1 is CT and lineup 2 TERRORIST in every round.
    const rounds: Array<{
      round: number;
      winner: string;
      kills: Array<[string, string]>;
    }> = [
      // a1 is left 1v2 and takes both.
      {
        round: 1,
        winner: "CT",
        kills: [
          [a1, b1],
          [b2, a2],
          [b3, a3],
          [a1, b2],
          [a1, b3],
        ],
      },
      // a3 is left 1v3 and dies.
      {
        round: 2,
        winner: "TERRORIST",
        kills: [
          [b1, a1],
          [b1, a2],
          [b2, a3],
        ],
      },
      // a3 is left 1v3 and the round is won some other way.
      {
        round: 3,
        winner: "CT",
        kills: [
          [b1, a1],
          [b1, a2],
        ],
      },
      // b3 is left 1v2, gets one, and falls to the last.
      {
        round: 4,
        winner: "CT",
        kills: [
          [a1, b1],
          [b2, a2],
          [a3, b2],
          [b3, a1],
          [a3, b3],
        ],
      },
      // No kills: no clutch.
      { round: 5, winner: "TERRORIST", kills: [] },
      // A teamkill puts a1 alone; a kill on someone outside both lineups
      // still counts as a clutch kill.
      {
        round: 6,
        winner: "TERRORIST",
        kills: [
          [a1, a2],
          [b1, a3],
          [a1, stranger],
          [a1, b1],
          [b2, a1],
        ],
      },
      // b3 is left 1v3 and takes all three; the kill after it is over is ignored.
      {
        round: 7,
        winner: "TERRORIST",
        kills: [
          [a1, b1],
          [a1, b2],
          [b3, a2],
          [b3, a3],
          [b3, a1],
          [b3, stranger],
        ],
      },
    ];
    for (const { round, winner, kills } of rounds) {
      for (const [i, [attacker, victim]] of kills.entries()) {
        await fx.kill(ctx, attacker, victim, {
          round,
          time: T(round * 100 - i),
        });
      }
      await fx.round(ctx.mapId, round, {
        winningSide: winner,
        time: T(round * 100 - 50),
      });
    }

    // A warmup round and a round later struck from the map are never read.
    await fx.kill(ctx, b1, a1, { round: 0, time: T(1000) });
    await fx.kill(ctx, b1, a2, { round: 0, time: T(999) });
    await fx.round(ctx.mapId, 0, { winningSide: "TERRORIST", time: T(990) });
    await fx.kill(ctx, b1, a1, { round: 8, time: T(10) });
    await fx.kill(ctx, b1, a2, { round: 8, time: T(9) });
    await fx.round(ctx.mapId, 8, { winningSide: "TERRORIST", time: T(5) });
    await postgres.query(
      "UPDATE match_map_rounds SET deleted_at = now() WHERE match_map_id = $1 AND round = 8",
      [ctx.mapId],
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const name = (id: string) =>
    Object.entries({ ...players, ...lineups }).find(([, v]) => v === id)?.[0] ??
    id;

  type Row = {
    round: number;
    match_lineup_id: string;
    clutcher_steam_id: string;
    side: string;
    against_count: number;
    kills_in_clutch: number;
    outcome: string;
  };

  const shape = (r: Row) => [
    Number(r.round),
    name(r.match_lineup_id),
    name(String(r.clutcher_steam_id)),
    r.side,
    Number(r.against_count),
    Number(r.kills_in_clutch),
    r.outcome,
  ];

  it("reports each round's clutch", async () => {
    const rows = await postgres.query<Array<Row & { match_map_id: string }>>(
      "SELECT * FROM v_match_clutches WHERE match_id = $1 ORDER BY round",
      [ctx.matchId],
    );

    expect(rows.every((r) => r.match_map_id === ctx.mapId)).toBe(true);
    expect(rows.map(shape)).toEqual([
      [1, "a", "a1", "ct", 2, 2, "won"],
      [2, "a", "a3", "ct", 3, 0, "lost"],
      [3, "a", "a3", "ct", 3, 0, "saved"],
      [4, "b", "b3", "t", 2, 1, "lost"],
      [6, "a", "a1", "ct", 3, 2, "lost"],
      [7, "b", "b3", "t", 3, 3, "won"],
    ]);
  });

  it("agrees with detect_round_clutch round by round", async () => {
    const fromView = await postgres.query<Array<Row>>(
      "SELECT * FROM v_match_clutches WHERE match_id = $1 ORDER BY round",
      [ctx.matchId],
    );
    const fromFunction = await postgres.query<Array<Row>>(
      `SELECT r.round, c.*
         FROM match_map_rounds r
         CROSS JOIN LATERAL detect_round_clutch(r.match_map_id, r.round) c
        WHERE r.match_map_id = $1 AND r.round > 0 AND r.deleted_at IS NULL
        ORDER BY r.round`,
      [ctx.mapId],
    );
    expect(fromFunction.map(shape)).toEqual(fromView.map(shape));
  });
});
