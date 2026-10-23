import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// players.elo_ratings keeps what compute_player_elo answers, so get_player_elo
// can read a column: it has to follow every rating, the seasons toggle and the
// active season, and the read has to inline.
describe("stored player elo", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerEloRatingsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199760000000n);
    await fx.region();
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
