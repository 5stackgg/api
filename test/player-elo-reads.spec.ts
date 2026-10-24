import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Pins what players.elo and the per-type lookups behind it answer, so how they
// find a player's rows can change without any rating changing with it.
describe("player elo reads", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let stageId: string;

  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerEloReadsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199750000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await fx.region();
    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    stageId = tournament.stageIds[0];
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_elo");
    await postgres.query("DELETE FROM seasons");
    await fx.enableSeasons(false);
  });

  async function match(): Promise<string> {
    return (await fx.bareMatch()).matchId;
  }

  async function elo(
    steamId: string,
    type: string,
    current: number,
    createdAt: string,
    {
      seasonId = null as string | null,
      voided = false,
      bracketed = false,
      matchId = null as string | null,
    } = {},
  ): Promise<string> {
    const id = matchId ?? (await match());
    if (bracketed) await bracket(id);
    await postgres.query(
      `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [steamId, id, type, current, createdAt, seasonId],
    );
    if (voided) {
      await postgres.query(
        "UPDATE matches SET elo_voided = true WHERE id = $1",
        [id],
      );
    }
    return id;
  }

  async function bracket(matchId: string): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, match_id)
       VALUES ($1, 1, (SELECT coalesce(max(match_number), 0) + 1 FROM tournament_brackets), $2) RETURNING id`,
      [stageId, matchId],
    );
    return row.id;
  }

  async function read(steamId: string) {
    const [row] = await postgres.query<
      Array<{ elo: Record<string, string | null> }>
    >("SELECT get_player_elo(p) AS elo FROM players p WHERE steam_id = $1", [
      steamId,
    ]);
    return Object.fromEntries(
      Object.entries(row.elo ?? {}).map(([k, v]) => [
        k,
        v === null ? null : Number(v),
      ]),
    );
  }

  async function tournamentElo(steamId: string, type: string) {
    const [row] = await postgres.query<Array<{ v: string | null }>>(
      "SELECT get_player_tournament_elo_by_type(p, $2) AS v FROM players p WHERE steam_id = $1",
      [steamId, type],
    );
    return row.v === null ? null : Number(row.v);
  }

  async function activeSeason(): Promise<string> {
    await fx.enableSeasons(true);
    return fx.season(ago(20), null);
  }

  it("reads the latest unvoided rating per type with seasons off", async () => {
    const player = await fx.player();
    await elo(player, "Competitive", 1000, ago(10));
    await elo(player, "Competitive", 1100, ago(5));
    await elo(player, "Competitive", 1200, ago(1), { voided: true });
    await elo(player, "Wingman", 900, ago(3));

    expect(await read(player)).toEqual({
      competitive: 1100,
      wingman: 900,
      duel: null,
      rush: null,
    });
  });

  it("has no ratings for a player with no rows", async () => {
    const player = await fx.player();
    expect(await read(player)).toEqual({
      competitive: null,
      wingman: null,
      duel: null,
      rush: null,
    });

    await activeSeason();
    expect(await read(player)).toEqual({
      competitive: null,
      wingman: null,
      duel: null,
      rush: null,
      tournament_competitive: null,
      tournament_wingman: null,
      tournament_duel: null,
      tournament_rush: null,
    });
  });

  it("splits season and tournament ladders with seasons on", async () => {
    const old = await fx.season(ago(400), ago(300));
    const season = await activeSeason();
    const player = await fx.player();

    await elo(player, "Competitive", 1500, ago(8), { seasonId: season });
    await elo(player, "Competitive", 1550, ago(2), {
      seasonId: season,
      voided: true,
    });
    await elo(player, "Competitive", 1600, ago(6));
    await elo(player, "Competitive", 2000, ago(9), { bracketed: true });
    await elo(player, "Competitive", 2100, ago(4), {
      bracketed: true,
      voided: true,
    });
    await elo(player, "Competitive", 2200, ago(3), {
      bracketed: true,
      seasonId: season,
    });

    await elo(player, "Wingman", 950, ago(12));
    await elo(player, "Wingman", 990, ago(7), { bracketed: true });

    await elo(player, "Duel", 700, ago(350), { seasonId: old });

    expect(await read(player)).toEqual({
      competitive: 2200,
      wingman: 5000,
      duel: 5000,
      rush: null,
      tournament_competitive: 2000,
      tournament_wingman: 990,
      tournament_duel: null,
      tournament_rush: null,
    });
  });

  it("starts a season at 5000 for a player rated only in tournaments", async () => {
    const season = await activeSeason();
    const player = await fx.player();
    await elo(player, "Competitive", 7773, ago(10), { bracketed: true });

    expect(await read(player)).toMatchObject({
      competitive: 5000,
      tournament_competitive: 7773,
    });
    const [gate] = await postgres.query<Array<{ v: string }>>(
      "SELECT get_player_season_elo_by_type(p, 'Competitive', $2) AS v FROM players p WHERE steam_id = $1",
      [player, season],
    );
    expect(Number(gate.v)).toBe(5000);

    await elo(player, "Competitive", 5258, ago(1), { seasonId: season });
    expect(await read(player)).toMatchObject({
      competitive: 5258,
      tournament_competitive: 7773,
    });
  });

  it("falls back to lifetime ratings between seasons", async () => {
    await fx.enableSeasons(true);
    const ended = await fx.season(ago(60), ago(30));
    const player = await fx.player();

    await elo(player, "Competitive", 1300, ago(40), { seasonId: ended });
    await elo(player, "Competitive", 1250, ago(20));
    await elo(player, "Rush", 400, ago(10), { bracketed: true });

    expect(await read(player)).toEqual({
      competitive: 1250,
      wingman: null,
      duel: null,
      rush: 400,
      tournament_competitive: null,
      tournament_wingman: null,
      tournament_duel: null,
      tournament_rush: 400,
    });
  });

  it("follows a match into and out of a bracket after it was rated", async () => {
    await activeSeason();
    const player = await fx.player();
    const first = await elo(player, "Competitive", 1800, ago(5));
    const second = await elo(player, "Competitive", 1700, ago(9));

    expect(await tournamentElo(player, "Competitive")).toBeNull();

    const bracketId = await bracket(second);
    expect(await tournamentElo(player, "Competitive")).toBe(1700);

    await postgres.query(
      "UPDATE tournament_brackets SET match_id = $2 WHERE id = $1",
      [bracketId, first],
    );
    expect(await tournamentElo(player, "Competitive")).toBe(1800);
    expect((await read(player)).tournament_competitive).toBe(1800);

    await postgres.query(
      "UPDATE tournament_brackets SET match_id = NULL WHERE id = $1",
      [bracketId],
    );
    expect(await tournamentElo(player, "Competitive")).toBeNull();
  });

  it("counts a rating written after its match was bracketed", async () => {
    await activeSeason();
    const player = await fx.player();
    const matchId = await match();
    await bracket(matchId);
    await elo(player, "Duel", 640, ago(1), { matchId });

    expect(await tournamentElo(player, "Duel")).toBe(640);
    expect(await tournamentElo(player, "Competitive")).toBeNull();
  });

  it("is the same per player across a mix of histories", async () => {
    const season = await activeSeason();
    const players = await fx.players(6);
    const types = ["Competitive", "Wingman", "Duel", "Rush"];
    let n = 0;
    for (const [i, player] of players.entries()) {
      for (let k = 0; k < 4 + i * 2; k++) {
        n++;
        await elo(
          player,
          types[(i + k) % 4],
          1000 + n * 7,
          ago(1 + ((n * 13) % 50)),
          {
            seasonId: k % 3 === 0 ? season : null,
            bracketed: k % 4 === 1,
            voided: k % 5 === 4,
          },
        );
      }
    }

    for (const player of players) {
      const [reference] = await postgres.query<
        Array<{ elo: Record<string, string | null> }>
      >(
        `WITH r AS (
           SELECT pe.type, pe.current, pe.created_at, pe.season_id,
                  EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id) AS bracketed
             FROM player_elo pe
            WHERE pe.steam_id = $1
              AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = pe.match_id AND m.elo_voided)
         ), t(type, key) AS (
           VALUES ('Competitive', 'competitive'), ('Wingman', 'wingman'), ('Duel', 'duel'), ('Rush', 'rush')
         )
         SELECT jsonb_object_agg(t.key, coalesce(
                  (SELECT current FROM r WHERE r.type = t.type AND r.season_id = $2 ORDER BY created_at DESC LIMIT 1),
                  (SELECT 5000 FROM r WHERE r.type = t.type LIMIT 1)))
             || jsonb_object_agg('tournament_' || t.key,
                  (SELECT current FROM r WHERE r.type = t.type AND r.season_id IS NULL AND r.bracketed ORDER BY created_at DESC LIMIT 1)) AS elo
           FROM t`,
        [player, season],
      );
      const expected = Object.fromEntries(
        Object.entries(reference.elo).map(([k, v]) => [
          k,
          v === null ? null : Number(v),
        ]),
      );
      expect(await read(player)).toEqual(expected);
    }
  });
});
