import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Pins the ELO board and where get_player_leaderboard_rank places each player
// on it, across every filter the leaderboard page and profile can send, so how
// either is computed can change without a standing moving.
describe("ELO leaderboard and rank", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let stageId: string;
  let players: Record<string, string>;
  let seasons: Record<string, string>;

  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  type Row = {
    player_steam_id: string;
    value: number;
    secondary_value: number;
    tertiary_value: number;
    matches_played: number;
  };

  async function bracket(matchId: string) {
    await postgres.query(
      `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, match_id)
       VALUES ($1, 1, (SELECT coalesce(max(match_number), 0) + 1 FROM tournament_brackets), $2)`,
      [stageId, matchId],
    );
  }

  async function elo(
    steamId: string,
    type: string,
    current: number,
    change: number,
    daysAgo: number,
    { season = null as string | null, voided = false, tournament = false } = {},
  ) {
    const { matchId } = await fx.bareMatch();
    if (tournament) await bracket(matchId);
    await postgres.query(
      `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [steamId, matchId, type, current, change, ago(daysAgo), season],
    );
    if (voided) {
      await postgres.query(
        "UPDATE matches SET elo_voided = true WHERE id = $1",
        [matchId],
      );
    }
  }

  async function finishedDuel(
    winner: string,
    loser: string,
    daysAgo: number,
    tournament = false,
  ) {
    const match = await fx.match({ type: "Duel" });
    await fx.lineupPlayer(match.lineup_1_id, winner);
    await fx.lineupPlayer(match.lineup_2_id, loser);
    await postgres.query(
      "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
      [match.id],
    );
    await postgres.query(
      "UPDATE matches SET ended_at = now() - make_interval(days => $2) WHERE id = $1",
      [match.id, daysAgo],
    );
    await fx.playFirstMap(match.id);
    if (tournament) await bracket(match.id);
  }

  beforeAll(async () => {
    db = await bootMigratedDb("LeaderboardEloRankTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199760000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await fx.region();
    await fx.setting("leaderboard_min_matches", "1");
    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    stageId = tournament.stageIds[0];

    await fx.enableSeasons(true);
    seasons = {
      ended: await fx.season(ago(120), ago(60)),
      active: await fx.season(ago(59), null),
    };

    const [a, b, c, d, e, f, g] = await fx.players(7);
    players = { a, b, c, d, e, f, g };

    await elo(a, "Competitive", 5100, 100, 100, { season: seasons.ended });
    await elo(a, "Competitive", 5250, 150, 50, { season: seasons.active });
    await elo(a, "Competitive", 5200, -50, 10, { season: seasons.active });
    await elo(a, "Competitive", 5200, 0, 5, {
      season: seasons.active,
      voided: true,
    });
    await elo(a, "Competitive", 6000, 300, 20, { tournament: true });

    await elo(b, "Competitive", 5050, 50, 200);
    await elo(b, "Competitive", 4900, -150, 40, { season: seasons.active });
    await elo(b, "Duel", 5100, 100, 3, { season: seasons.active });

    await elo(c, "Competitive", 5300, 300, 15, { tournament: true });

    await elo(d, "Duel", 5200, 200, 90, { season: seasons.ended });
    await elo(d, "Duel", 5150, -50, 25, { season: seasons.active });
    await elo(d, "Duel", 5400, 250, 2, { season: seasons.active });
    await elo(d, "Duel", 5650, 250, 1, { tournament: true });

    await elo(e, "Competitive", 5000, 0, 1, {
      season: seasons.active,
      voided: true,
    });

    await elo(f, "Competitive", 5500, 500, 70, { season: seasons.ended });
    await elo(f, "Competitive", 5450, -50, 45, { season: seasons.active });
    await elo(f, "Competitive", 5450, 0, 4, { season: seasons.active });

    await finishedDuel(d, b, 6);
    await finishedDuel(d, b, 4, true);
    await finishedDuel(b, d, 8);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const windows = [0, 30];
  const types = [null, "Competitive", "Duel"];
  const excludes = [false, true];
  const seasonKeys = [null, "active", "ended"];
  const sources = ["overall", "matchmaking", "tournament", "league"];

  function combos() {
    const out: Array<{
      window: number;
      type: string | null;
      exclude: boolean;
      season: string | null;
      source: string;
    }> = [];
    for (const window of windows)
      for (const type of types)
        for (const exclude of excludes)
          for (const season of seasonKeys)
            for (const source of sources)
              out.push({ window, type, exclude, season, source });
    return out;
  }

  function key(c: ReturnType<typeof combos>[number]) {
    return [
      c.window,
      c.type ?? "any",
      c.exclude ? "excl" : "incl",
      c.season ?? "none",
      c.source,
    ].join("/");
  }

  const name = (steamId: string) =>
    Object.entries(players).find(([, id]) => id === steamId)?.[0] ?? steamId;

  async function board(c: ReturnType<typeof combos>[number]) {
    const rows = await postgres.query<Array<Row>>(
      "SELECT * FROM get_leaderboard('elo', $1, $2, $3, NULL, $4, $5)",
      [
        c.window,
        c.type,
        c.exclude,
        c.season ? seasons[c.season] : null,
        c.source,
      ],
    );
    return rows
      .map((r) => [
        name(r.player_steam_id),
        Number(r.value),
        Number(r.secondary_value),
        Number(r.tertiary_value),
        Number(r.matches_played),
      ])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  }

  // Every board the fixture produces, as [player, value, secondary, tertiary,
  // matches played] sorted by player; any combination not listed is empty.
  // prettier-ignore
  const BOARDS: Array<[Array<string>, Array<[string, number, number, number, number]>]> = [
    [["0/any/incl/none/overall"], [["a",6000,0,0,4],["b",5100,0,0,3],["c",5300,0,0,1],["d",5650,0,2,4],["f",5500,0,0,3]]],
    [["0/any/incl/none/matchmaking"], [["a",6000,0,0,3],["b",5100,0,0,3],["d",5650,0,1,3],["f",5500,0,0,3]]],
    [["0/any/incl/none/tournament"], [["a",6000,0,0,1],["c",5300,0,0,1],["d",5650,0,1,1]]],
    [["0/any/incl/active/overall","30/any/incl/active/overall"], [["a",5500,-50,0,3],["b",5100,100,0,2],["c",5300,300,0,1],["d",5650,250,2,3],["f",5450,0,0,2]]],
    [["0/any/incl/active/matchmaking","30/any/incl/active/matchmaking"], [["a",5500,100,0,2],["b",5100,-50,0,2],["d",5650,200,1,2],["f",5450,-50,0,2]]],
    [["0/any/incl/active/tournament","30/any/incl/active/tournament"], [["a",5500,300,0,1],["c",5300,300,0,1],["d",5650,250,1,1]]],
    [["0/any/incl/ended/overall","0/any/incl/ended/matchmaking","0/any/excl/ended/overall","0/any/excl/ended/matchmaking","30/any/incl/ended/overall","30/any/incl/ended/matchmaking","30/any/excl/ended/overall","30/any/excl/ended/matchmaking"], [["a",5100,100,0,1],["d",5200,200,0,1],["f",5500,500,0,1]]],
    [["0/any/excl/none/overall"], [["a",5150,0,0,3],["b",5100,0,0,3],["c",5000,0,0,0],["d",5200,0,1,3],["f",5500,0,0,3]]],
    [["0/any/excl/none/matchmaking"], [["a",5150,0,0,3],["b",5100,0,0,3],["d",5200,0,1,3],["f",5500,0,0,3]]],
    [["0/any/excl/active/overall","30/any/excl/active/overall"], [["a",5200,100,0,2],["b",5100,50,0,2],["d",5400,200,1,2],["f",5450,-50,0,2]]],
    [["0/any/excl/active/matchmaking","30/any/excl/active/matchmaking"], [["a",5200,100,0,2],["b",5100,-50,0,2],["d",5400,200,1,2],["f",5450,-50,0,2]]],
    [["0/Competitive/incl/none/overall"], [["a",6000,0,0,4],["b",5050,0,0,2],["c",5300,0,0,1],["f",5500,0,0,3]]],
    [["0/Competitive/incl/none/matchmaking"], [["a",6000,0,0,3],["b",5050,0,0,2],["f",5500,0,0,3]]],
    [["0/Competitive/incl/none/tournament"], [["a",6000,0,0,1],["c",5300,0,0,1]]],
    [["0/Competitive/incl/active/overall","30/Competitive/incl/active/overall"], [["a",5500,-50,0,3],["b",4900,-150,0,1],["c",5300,300,0,1],["f",5450,0,0,2]]],
    [["0/Competitive/incl/active/matchmaking","30/Competitive/incl/active/matchmaking"], [["a",5500,100,0,2],["b",4900,-150,0,1],["f",5450,-50,0,2]]],
    [["0/Competitive/incl/active/tournament","30/Competitive/incl/active/tournament"], [["a",5500,300,0,1],["c",5300,300,0,1]]],
    [["0/Competitive/incl/ended/overall","0/Competitive/incl/ended/matchmaking","0/Competitive/excl/ended/overall","0/Competitive/excl/ended/matchmaking","30/Competitive/incl/ended/overall","30/Competitive/incl/ended/matchmaking","30/Competitive/excl/ended/overall","30/Competitive/excl/ended/matchmaking"], [["a",5100,100,0,1],["f",5500,500,0,1]]],
    [["0/Competitive/excl/none/overall"], [["a",5150,0,0,3],["b",5050,0,0,2],["c",5000,0,0,0],["f",5500,0,0,3]]],
    [["0/Competitive/excl/none/matchmaking"], [["a",5150,0,0,3],["b",5050,0,0,2],["f",5500,0,0,3]]],
    [["0/Competitive/excl/active/overall","0/Competitive/excl/active/matchmaking","30/Competitive/excl/active/overall","30/Competitive/excl/active/matchmaking"], [["a",5200,100,0,2],["b",4900,-150,0,1],["f",5450,-50,0,2]]],
    [["0/Duel/incl/none/overall"], [["b",5100,0,0,1],["d",5650,0,2,4]]],
    [["0/Duel/incl/none/matchmaking"], [["b",5100,0,0,1],["d",5650,0,1,3]]],
    [["0/Duel/incl/none/tournament"], [["d",5650,0,1,1]]],
    [["0/Duel/incl/active/overall","30/Duel/incl/active/overall"], [["b",5100,100,0,1],["d",5650,250,2,3]]],
    [["0/Duel/incl/active/matchmaking","30/Duel/incl/none/matchmaking","30/Duel/incl/active/matchmaking"], [["b",5100,100,0,1],["d",5650,200,1,2]]],
    [["0/Duel/incl/active/tournament","30/Duel/incl/none/tournament","30/Duel/incl/active/tournament"], [["d",5650,250,1,1]]],
    [["0/Duel/incl/ended/overall","0/Duel/incl/ended/matchmaking","0/Duel/excl/ended/overall","0/Duel/excl/ended/matchmaking","30/Duel/incl/ended/overall","30/Duel/incl/ended/matchmaking","30/Duel/excl/ended/overall","30/Duel/excl/ended/matchmaking"], [["d",5200,200,0,1]]],
    [["0/Duel/excl/none/overall","0/Duel/excl/none/matchmaking"], [["b",5100,0,0,1],["d",5200,0,1,3]]],
    [["0/Duel/excl/active/overall","0/Duel/excl/active/matchmaking","30/Duel/excl/none/overall","30/Duel/excl/none/matchmaking","30/Duel/excl/active/overall","30/Duel/excl/active/matchmaking"], [["b",5100,100,0,1],["d",5400,200,1,2]]],
    [["30/any/incl/none/overall"], [["a",5200,250,0,2],["b",5100,100,0,1],["c",5300,300,0,1],["d",5650,450,2,3],["f",5450,0,0,1]]],
    [["30/any/incl/none/matchmaking"], [["a",5200,-50,0,1],["b",5100,100,0,1],["d",5650,200,1,2],["f",5450,0,0,1]]],
    [["30/any/incl/none/tournament"], [["a",5200,300,0,1],["c",5300,300,0,1],["d",5650,250,1,1]]],
    [["30/any/excl/none/overall"], [["a",4900,-50,0,1],["b",5100,100,0,1],["c",5000,0,0,0],["d",5400,200,1,2],["f",5450,0,0,1]]],
    [["30/any/excl/none/matchmaking"], [["a",4900,-50,0,1],["b",5100,100,0,1],["d",5400,200,1,2],["f",5450,0,0,1]]],
    [["30/Competitive/incl/none/overall"], [["a",5200,250,0,2],["c",5300,300,0,1],["f",5450,0,0,1]]],
    [["30/Competitive/incl/none/matchmaking"], [["a",5200,-50,0,1],["f",5450,0,0,1]]],
    [["30/Competitive/incl/none/tournament"], [["a",5200,300,0,1],["c",5300,300,0,1]]],
    [["30/Competitive/excl/none/overall"], [["a",4900,-50,0,1],["c",5000,0,0,0],["f",5450,0,0,1]]],
    [["30/Competitive/excl/none/matchmaking"], [["a",4900,-50,0,1],["f",5450,0,0,1]]],
    [["30/Duel/incl/none/overall"], [["b",5100,100,0,1],["d",5650,450,2,3]]],
  ];

  it("keeps every board where it was", async () => {
    const expected = new Map<string, unknown>();
    for (const [keys, rows] of BOARDS)
      for (const k of keys) expected.set(k, rows);
    for (const c of combos()) {
      expect({ combo: key(c), board: await board(c) }).toEqual({
        combo: key(c),
        board: expected.get(key(c)) ?? [],
      });
    }
  });

  it("ranks every player where the board places them", async () => {
    for (const c of combos()) {
      const season = c.season ? seasons[c.season] : null;
      const rows = await postgres.query<Array<Row>>(
        "SELECT * FROM get_leaderboard('elo', $1, $2, $3, NULL, $4, $5)",
        [c.window, c.type, c.exclude, season, c.source],
      );
      for (const steamId of Object.values(players)) {
        const ranks = await postgres.query<
          Array<{ value: number; rank: number; total: number }>
        >(
          "SELECT * FROM get_player_leaderboard_rank('elo', $1, $2, $3, $4, $5, $6)",
          [c.window, steamId, c.type, c.exclude, season, c.source],
        );
        const mine = rows.find((r) => r.player_steam_id === steamId);
        const expected = mine
          ? [
              {
                value: Number(mine.value),
                rank:
                  1 +
                  rows.filter((r) => Number(r.value) > Number(mine.value))
                    .length,
                total: rows.length,
              },
            ]
          : [];
        expect({
          combo: key(c),
          player: name(steamId),
          rank: ranks.map((r) => ({
            value: Number(r.value),
            rank: Number(r.rank),
            total: Number(r.total),
          })),
        }).toEqual({ combo: key(c), player: name(steamId), rank: expected });
      }
    }
  });
});
