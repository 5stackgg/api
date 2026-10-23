import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// players.elo_ratings keeps what compute_player_elo answers, so get_player_elo
// can read a column: it has to follow every rating, the seasons toggle and the
// active season, and the read has to inline.
describe("stored player elo", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let stageId: string;

  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerEloRatingsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199760000000n);
    await fx.region();
    const tfx = new TournamentFixtures(postgres, fx);
    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    stageId = tournament.stageIds[0];

    // The two ways players.elo was worked out before it was stored: the
    // player_elo_current read it replaced, and the per-type lookups straight
    // over player_elo that it was itself checked against.
    await postgres.query(`
      CREATE FUNCTION test_elo_from_current(player public.players) RETURNS jsonb
      LANGUAGE sql STABLE AS $$
        SELECT CASE WHEN s.seasons THEN jsonb_build_object(
                'competitive', COALESCE(sr.competitive, lr.competitive),
                'wingman', COALESCE(sr.wingman, lr.wingman),
                'duel', COALESCE(sr.duel, lr.duel),
                'rush', COALESCE(sr.rush, lr.rush),
                'tournament_competitive', tr.competitive,
                'tournament_wingman', tr.wingman,
                'tournament_duel', tr.duel,
                'tournament_rush', tr.rush)
            ELSE jsonb_build_object(
                'competitive', lr.competitive,
                'wingman', lr.wingman,
                'duel', lr.duel,
                'rush', lr.rush)
            END
        FROM (SELECT seasons_enabled() AS seasons, get_active_season() AS season_id) s
        LEFT JOIN player_elo_current lr ON lr.steam_id = player.steam_id AND lr.ladder = 'lifetime'
        LEFT JOIN player_elo_current sr ON sr.steam_id = player.steam_id AND sr.ladder = 'season' AND sr.season_id = s.season_id
        LEFT JOIN player_elo_current tr ON tr.steam_id = player.steam_id AND tr.ladder = 'tournament';
      $$`);
    await postgres.query(`
      CREATE FUNCTION test_elo_from_rows(player public.players) RETURNS jsonb
      LANGUAGE sql STABLE AS $$
        SELECT CASE WHEN seasons_enabled() THEN jsonb_build_object(
                'competitive', get_player_season_elo_by_type(player, 'Competitive', get_active_season()),
                'wingman', get_player_season_elo_by_type(player, 'Wingman', get_active_season()),
                'duel', get_player_season_elo_by_type(player, 'Duel', get_active_season()),
                'rush', get_player_season_elo_by_type(player, 'Rush', get_active_season()),
                'tournament_competitive', get_player_tournament_elo_by_type(player, 'Competitive'),
                'tournament_wingman', get_player_tournament_elo_by_type(player, 'Wingman'),
                'tournament_duel', get_player_tournament_elo_by_type(player, 'Duel'),
                'tournament_rush', get_player_tournament_elo_by_type(player, 'Rush'))
            ELSE jsonb_build_object(
                'competitive', get_player_elo_by_type(player, 'Competitive'),
                'wingman', get_player_elo_by_type(player, 'Wingman'),
                'duel', get_player_elo_by_type(player, 'Duel'),
                'rush', get_player_elo_by_type(player, 'Rush'))
            END
      $$`);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_elo");
    await postgres.query("DELETE FROM seasons");
    await fx.enableSeasons(false);
  });

  async function elo(
    steamId: string,
    type: string,
    current: number,
    createdAt: string,
    seasonId: string | null = null,
  ) {
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [steamId, matchId, type, current, createdAt, seasonId],
    );
    return matchId;
  }

  async function stored(steamId: string) {
    const [row] = await postgres.query<
      Array<{ stored: unknown; computed: unknown; read: unknown }>
    >(
      `SELECT elo_ratings AS stored, compute_player_elo(steam_id) AS computed,
              get_player_elo(p) AS read
       FROM players p WHERE steam_id = $1`,
      [steamId],
    );
    return row;
  }

  it("stores a player's elo as soon as a rating is written or voided", async () => {
    const player = await fx.player();
    const matchId = await elo(player, "Competitive", 1100, ago(2));

    let row = await stored(player);
    expect(row.stored).toEqual(row.computed);
    expect(row.stored).toMatchObject({ competitive: 1100 });

    await postgres.query("UPDATE matches SET elo_voided = true WHERE id = $1", [
      matchId,
    ]);
    row = await stored(player);
    expect(row.stored).toEqual(row.computed);
    expect(row.stored).toMatchObject({ competitive: null });
  });

  it("rebuilds every player when seasons are switched on", async () => {
    const season = await fx.season(ago(20), null);
    const player = await fx.player();
    await elo(player, "Competitive", 1200, ago(10));
    await elo(player, "Competitive", 1500, ago(5), season);
    expect(Object.keys((await stored(player)).stored as object)).toHaveLength(
      4,
    );

    await fx.enableSeasons(true);

    const row = await stored(player);
    expect(row.stored).toEqual(row.computed);
    expect(row.stored).toMatchObject({
      competitive: 1500,
      tournament_competitive: null,
    });
  });

  it("follows a season added while seasons are on", async () => {
    await fx.enableSeasons(true);
    const player = await fx.player();
    await elo(player, "Wingman", 900, ago(10));
    const season = await fx.season(ago(400), ago(300));
    await elo(player, "Wingman", 1300, ago(350), season);

    await fx.season(ago(5), null);

    const row = await stored(player);
    expect(row.stored).toEqual(row.computed);
    expect(row.stored).toMatchObject({ wingman: 900 });
  });

  it("follows the active season ending with nothing written", async () => {
    await fx.enableSeasons(true);
    const ends = new Date(Date.now() + 2_000).toISOString();
    const season = await fx.season(ago(5), ends);
    const player = await fx.player();
    await elo(player, "Duel", 950, ago(1), season);
    await elo(player, "Duel", 800, ago(0.5));
    expect((await stored(player)).stored).toMatchObject({ duel: 950 });

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const [{ rebuilt }] = await postgres.query<Array<{ rebuilt: boolean }>>(
      "SELECT refresh_player_elo_ratings_if_stale() AS rebuilt",
    );

    expect(rebuilt).toBe(true);
    const row = await stored(player);
    expect(row.stored).toEqual(row.computed);
    expect(row.stored).toMatchObject({ duel: 800 });
  });

  it("answers for a player with nothing stored, and the check fills them in", async () => {
    const player = await fx.player();
    await elo(player, "Rush", 650, ago(3));
    await postgres.query(
      "UPDATE players SET elo_ratings = NULL WHERE steam_id = $1",
      [player],
    );

    let row = await stored(player);
    expect(row.stored).toBeNull();
    expect(row.read).toEqual(row.computed);

    await postgres.query("SELECT refresh_player_elo_ratings_if_stale()");
    row = await stored(player);
    expect(row.stored).toEqual(row.computed);
  });

  it("answers what elo was worked out as before, for every player, through random writes", async () => {
    // mulberry32: the same sequence every run, so a failure names its step.
    let seed = 20261023;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: T[]): T =>
      items[Math.floor(random() * items.length)];
    const TYPES = ["Competitive", "Wingman", "Duel", "Rush"];
    const SEASONS: Array<[number, number | null]> = [
      [400, 300],
      [300, 200],
      [200, 100],
      [100, null],
      [30, -0.001],
    ];

    const players = await fx.players(12);
    // New players are filled in by the once-a-minute check.
    await postgres.query("SELECT refresh_player_elo_ratings_if_stale()");
    const seasons = new Map<number, string>();
    const matches: string[] = [];

    const step = async () => {
      const roll = random();
      if (roll < 0.4) {
        const { matchId } = await fx.bareMatch();
        matches.push(matchId);
        if (random() < 0.25) {
          await postgres.query(
            `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, match_id)
             VALUES ($1, 1, (SELECT coalesce(max(match_number), 0) + 1 FROM tournament_brackets), $2)`,
            [stageId, matchId],
          );
        }
        const seasonIds = [...seasons.values()];
        await postgres.query(
          `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
           VALUES ($1, $2, $3, $4, 0, $5, $6)`,
          [
            pick(players),
            matchId,
            pick(TYPES),
            Math.floor(500 + random() * 2000),
            ago(random() * 400),
            seasonIds.length && random() < 0.5 ? pick(seasonIds) : null,
          ],
        );
        return "rate";
      }
      if (roll < 0.5 && matches.length) {
        await postgres.query(
          "UPDATE matches SET elo_voided = NOT elo_voided WHERE id = $1",
          [pick(matches)],
        );
        return "void";
      }
      if (roll < 0.58) {
        await postgres.query(
          `UPDATE player_elo SET "current" = $1
           WHERE ctid = (SELECT ctid FROM player_elo ORDER BY random() LIMIT 1)`,
          [Math.floor(500 + random() * 2000)],
        );
        return "re-rate";
      }
      if (roll < 0.63) {
        await postgres.query(
          "DELETE FROM player_elo WHERE ctid = (SELECT ctid FROM player_elo ORDER BY random() LIMIT 1)",
        );
        return "delete rating";
      }
      if (roll < 0.68 && matches.length) {
        const matchId = pick(matches);
        await postgres.query(
          "DELETE FROM tournament_brackets WHERE match_id = $1",
          [matchId],
        );
        return "unbracket";
      }
      if (roll < 0.76) {
        await fx.enableSeasons(random() < 0.5);
        return "toggle seasons";
      }
      if (roll < 0.86) {
        const index = Math.floor(random() * SEASONS.length);
        if (seasons.has(index)) {
          await postgres.query("DELETE FROM seasons WHERE id = $1", [
            seasons.get(index),
          ]);
          seasons.delete(index);
          return "remove season";
        }
        const [start, end] = SEASONS[index];
        try {
          seasons.set(
            index,
            await fx.season(ago(start), end === null ? null : ago(end)),
          );
        } catch {
          return "season overlaps";
        }
        return "add season";
      }
      if (roll < 0.93 && seasons.size) {
        await postgres.query(
          "UPDATE seasons SET ends_at = CASE WHEN ends_at IS NULL THEN now() ELSE NULL END WHERE id = $1",
          [pick([...seasons.values()])],
        );
        return "end or reopen season";
      }
      return "nothing";
    };

    for (let index = 0; index < 160; index++) {
      let done: string;
      try {
        done = await step();
      } catch (error) {
        done = `skipped: ${(error as Error).message}`;
      }
      const [row] = await postgres.query<
        Array<{ from_current: number; from_rows: number; unstored: number }>
      >(
        `SELECT
           count(*) FILTER (WHERE get_player_elo(p) IS DISTINCT FROM test_elo_from_current(p))::int AS from_current,
           count(*) FILTER (WHERE get_player_elo(p) IS DISTINCT FROM test_elo_from_rows(p))::int AS from_rows,
           count(*) FILTER (WHERE elo_ratings IS NULL)::int AS unstored
         FROM players p WHERE steam_id = ANY ($1::bigint[])`,
        [players],
      );
      expect({ step: index, done, ...row }).toEqual({
        step: index,
        done,
        from_current: 0,
        from_rows: 0,
        unstored: 0,
      });
    }
  }, 300_000);

  it("reads the stored column inline, the way Hasura selects it", async () => {
    const player = await fx.player();
    const plan = (
      await postgres.query<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (VERBOSE, COSTS OFF)
         SELECT public.get_player_elo("_root.base") AS elo
         FROM (SELECT * FROM public.players WHERE steam_id = ANY ($1::bigint[])) AS "_root.base"`,
        [[player]],
      )
    )
      .map((line) => line["QUERY PLAN"])
      .join("\n");

    expect(plan).not.toContain("get_player_elo");
    expect(plan).toContain("elo_ratings");
  });
});
