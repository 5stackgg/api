import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// The /bans list: one row per player banned recently on Steam (VAC / game) or
// here (staff / the automatic VAC rule), against a real database.
describe("recently_banned_players (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  type Entry = {
    steam_id: string;
    banned_at: Date;
    banned_at_source: string;
    steam_banned_on: Date | string | null;
    vac_banned_on: Date | string | null;
    game_banned_on: Date | string | null;
    vac_ban_count: number;
    game_ban_count: number;
    sanction_id: string | null;
    sanction_kind: string | null;
    banned_here: boolean;
    first_match_at: Date | null;
    last_match_at: Date | null;
    last_match_map: string | null;
    matches_played: number;
    matches_since_steam_ban: number | null;
    arrived_banned: boolean;
    shared_matches: Array<{
      match_id: string;
      played_at: string;
      map: string | null;
      viewer_score: number;
      other_score: number;
      won: boolean | null;
      side: string;
    }> | null;
  };

  type Args = {
    window?: number;
    kinds?: Array<string>;
    status?: string;
    timing?: string;
    playedWith?: string;
    lostOnly?: boolean;
    search?: string | null;
  };

  beforeAll(async () => {
    db = await bootMigratedDb("RecentlyBannedPlayersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196200000000n);
    await fx.region("TestBans");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM players");
  });

  const SQL = `SELECT * FROM public.recently_banned_players(
      _window_days => $1::int,
      _kinds => $2::text[],
      _status => $3::text,
      _timing => $4::text,
      _played_with => $5::text,
      _lost_only => $6::boolean,
      _search => $7::text,
      hasura_session => $8::json
    )`;

  const params = (args: Args, session: object | null) => [
    args.window ?? 30,
    args.kinds ?? ["vac", "game", "staff", "auto"],
    args.status ?? "any",
    args.timing ?? "any",
    args.playedWith ?? "any",
    args.lostOnly ?? false,
    args.search ?? null,
    session ? JSON.stringify(session) : null,
  ];

  // As a guest: no session at all.
  const list = (args: Args = {}) =>
    postgres.query<Array<Entry>>(SQL, params(args, null));

  // As a signed-in viewer, the way Hasura calls it: the session argument.
  const listAs = (viewer: string, args: Args = {}) =>
    postgres.query<Array<Entry>>(
      SQL,
      params(args, { "x-hasura-role": "user", "x-hasura-user-id": viewer }),
    );

  const ids = (rows: Array<Entry>) => rows.map((row) => String(row.steam_id));

  // node-postgres hands a date column back as local midnight.
  const day = (value: Date | string | null) =>
    value instanceof Date
      ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
      : String(value);

  // What Steam reported on the last check: the latest ban was `daysAgo` whole
  // days before `checkedDaysAgo`.
  const steamBan = (
    steam: string,
    {
      vac = 0,
      game = 0,
      daysAgo,
      checkedDaysAgo = 0,
    }: {
      vac?: number;
      game?: number;
      daysAgo: number;
      checkedDaysAgo?: number;
    },
  ) =>
    postgres.query(
      `UPDATE players
          SET vac_banned = $2 > 0,
              vac_ban_count = $2,
              game_ban_count = $3,
              days_since_last_ban = $4,
              steam_bans_checked_at = now() - make_interval(days => $5)
        WHERE steam_id = $1`,
      [steam, vac, game, daysAgo, checkedDaysAgo],
    );

  const banDates = (steam: string, vacDaysAgo: number, gameDaysAgo: number) =>
    postgres.query(
      `UPDATE players
          SET last_vac_ban_at = now() - make_interval(days => $2),
              last_game_ban_at = now() - make_interval(days => $3)
        WHERE steam_id = $1`,
      [steam, vacDaysAgo, gameDaysAgo],
    );

  const utcDay = async (daysAgo: number) => {
    const [{ value }] = await postgres.query<Array<{ value: string }>>(
      "SELECT ((now() AT TIME ZONE 'UTC')::date - $1::int)::text AS value",
      [daysAgo],
    );
    return value;
  };

  const sanction = async (
    steam: string,
    {
      by = null,
      hoursAgo,
      lengthDays = null,
      deleted = false,
      type = "ban",
    }: {
      by?: string | null;
      hoursAgo: number;
      lengthDays?: number | null;
      deleted?: boolean;
      type?: string;
    },
  ): Promise<string> => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason, created_at, remove_sanction_date, deleted_at)
       VALUES (
         $1, $2, $3, 'test',
         now() - make_interval(hours => $4),
         CASE WHEN $5::int IS NULL THEN NULL
              ELSE now() - make_interval(hours => $4) + make_interval(days => $5::int) END,
         CASE WHEN $6 THEN now() ELSE NULL END
       ) RETURNING id`,
      [steam, by, type, hoursAgo, lengthDays, deleted],
    );
    return row.id;
  };

  // A finished best of 1 between two lineups.
  const match = async ({
    lineup1,
    lineup2,
    daysAgo,
    winner = 1,
    score = [13, 7],
    map = "de_mirage",
  }: {
    lineup1: Array<string>;
    lineup2: Array<string>;
    daysAgo: number;
    winner?: 1 | 2 | null;
    score?: [number, number];
    map?: string;
  }): Promise<string> => {
    const { matchId, mapId } = await fx.bareMatch();
    const [lineups] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >("SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [matchId]);
    for (const steam of lineup1) {
      await fx.lineupPlayer(lineups.lineup_1_id, steam);
    }
    for (const steam of lineup2) {
      await fx.lineupPlayer(lineups.lineup_2_id, steam);
    }
    await postgres.query(
      "UPDATE match_maps SET map_id = (SELECT id FROM maps WHERE name = $2 LIMIT 1) WHERE id = $1",
      [mapId, map],
    );
    await fx.roundScore(mapId, score[0], score[1]);
    await fx.finishMap(mapId);
    await postgres.query(
      `UPDATE matches
          SET started_at = now() - make_interval(days => $2),
              ended_at = now() - make_interval(days => $2) + interval '40 minutes'
        WHERE id = $1`,
      [matchId, daysAgo],
    );
    if (winner === null) {
      await postgres.query("UPDATE matches SET status = 'Tie' WHERE id = $1", [
        matchId,
      ]);
    } else {
      await postgres.query(
        `UPDATE matches SET winning_lineup_id = ${
          winner === 1 ? "lineup_1_id" : "lineup_2_id"
        } WHERE id = $1`,
        [matchId],
      );
    }
    return matchId;
  };

  describe("kinds and window", () => {
    let vacAuto: string;
    let gameOnly: string;
    let staff: string;
    let old: string;
    let lifted: string;

    beforeEach(async () => {
      const moderator = await fx.player("mod", "moderator");
      vacAuto = await fx.player("vacauto");
      gameOnly = await fx.player("gameonly");
      staff = await fx.player("staffbanned");
      old = await fx.player("oldvac");
      lifted = await fx.player("lifted");

      await steamBan(vacAuto, { vac: 1, daysAgo: 2 });
      await sanction(vacAuto, { hoursAgo: 2 * 24 - 3 });
      await steamBan(gameOnly, { game: 1, daysAgo: 5 });
      await sanction(staff, { by: moderator, hoursAgo: 24 });
      await steamBan(old, { vac: 1, daysAgo: 40 });
      await sanction(old, { hoursAgo: 40 * 24 });
      await sanction(lifted, {
        by: moderator,
        hoursAgo: 10 * 24,
        deleted: true,
      });
    });

    it("lists every kind inside the window, newest ban first", async () => {
      expect(ids(await list())).toEqual([staff, vacAuto, gameOnly]);
    });

    it("narrows to the requested kinds", async () => {
      expect(ids(await list({ kinds: ["vac"] }))).toEqual([vacAuto]);
      expect(ids(await list({ kinds: ["game"] }))).toEqual([gameOnly]);
      expect(ids(await list({ kinds: ["staff"] }))).toEqual([staff]);
      expect(ids(await list({ kinds: ["auto"] }))).toEqual([vacAuto]);
    });

    it("a longer window reaches older bans; a lifted ban never shows", async () => {
      expect(ids(await list({ window: 60 }))).toEqual([
        staff,
        vacAuto,
        gameOnly,
        old,
      ]);
    });

    it("anchors on the 5Stack ban when it lands the same day as Steam's", async () => {
      const [both] = await list({ search: "vacauto" });
      expect(both.banned_at_source).toBe("5stack");
      expect(both.sanction_kind).toBe("auto");

      const [steamOnly] = await list({ kinds: ["vac"] });
      expect(steamOnly.banned_at_source).toBe("steam");
      const banDay = day(steamOnly.steam_banned_on);
      expect(steamOnly.banned_at.toISOString()).toBe(
        new Date(`${banDay}T00:00:00Z`).toISOString(),
      );
    });

    it("dates a Steam ban from when Steam was asked, not from today", async () => {
      // Checked 10 days ago, banned 3 days before that: 13 days ago.
      await steamBan(gameOnly, { game: 1, daysAgo: 3, checkedDaysAgo: 10 });
      const [row] = await list({ kinds: ["game"] });
      const [{ expected }] = await postgres.query<Array<{ expected: string }>>(
        "SELECT ((now() AT TIME ZONE 'UTC')::date - 13)::text AS expected",
      );
      expect(day(row.steam_banned_on)).toBe(expected);
      expect(await list({ kinds: ["game"], window: 7 })).toEqual([]);
    });

    it("dates each kind of Steam ban on its own", async () => {
      const both = await fx.player("bothkinds");
      await steamBan(both, { vac: 1, game: 1, daysAgo: 2 });
      await banDates(both, 3700, 2);

      expect(ids(await list({ kinds: ["vac"] }))).toEqual([vacAuto]);
      const [row] = await list({ kinds: ["game"], search: "bothkinds" });
      expect(day(row.vac_banned_on)).toBe(await utcDay(3700));
      expect(day(row.game_banned_on)).toBe(await utcDay(2));
      expect(row.banned_at.toISOString()).toBe(
        new Date(`${await utcDay(2)}T00:00:00Z`).toISOString(),
      );
    });

    it("a recent VAC ban doesn't make an old game ban recent", async () => {
      const both = await fx.player("bothkinds");
      await steamBan(both, { vac: 1, game: 1, daysAgo: 1 });
      await banDates(both, 1, 900);

      expect(ids(await list({ kinds: ["game"] }))).toEqual([gameOnly]);
      expect(ids(await list({ kinds: ["vac"] }))).toEqual([both, vacAuto]);
    });

    it("lists a row under the day of the kind asked for", async () => {
      const both = await fx.player("bothkinds");
      await steamBan(both, { vac: 1, game: 1, daysAgo: 3 });
      await banDates(both, 10, 3);

      const [vacOnly] = await list({ kinds: ["vac"], search: "bothkinds" });
      expect(vacOnly.banned_at.toISOString()).toBe(
        new Date(`${await utcDay(10)}T00:00:00Z`).toISOString(),
      );
      const [anyKind] = await list({ search: "bothkinds" });
      expect(anyKind.banned_at.toISOString()).toBe(
        new Date(`${await utcDay(3)}T00:00:00Z`).toISOString(),
      );
    });

    it("falls back to the newest Steam ban when a kind has no date of its own", async () => {
      const [row] = await list({ kinds: ["game"] });
      expect(day(row.game_banned_on)).toBe(await utcDay(5));
      expect(row.vac_banned_on).toBeNull();
    });
  });

  describe("banned here", () => {
    it("tells an active ban from a timed one that has ended", async () => {
      const moderator = await fx.player("mod", "moderator");
      const ended = await fx.player("ended");
      const active = await fx.player("active");
      await sanction(ended, {
        by: moderator,
        hoursAgo: 20 * 24,
        lengthDays: 7,
      });
      await sanction(active, {
        by: moderator,
        hoursAgo: 3 * 24,
        lengthDays: 7,
      });

      const rows = await list();
      const byId = new Map(rows.map((row) => [String(row.steam_id), row]));
      expect(byId.get(ended)!.banned_here).toBe(false);
      expect(byId.get(ended)!.sanction_kind).toBe("staff");
      expect(byId.get(active)!.banned_here).toBe(true);

      expect(ids(await list({ status: "banned_here" }))).toEqual([active]);
    });

    it("not_banned_here keeps Steam-banned players who can still play", async () => {
      const gameOnly = await fx.player("gameonly");
      const vacAuto = await fx.player("vacauto");
      const staffOnly = await fx.player("staffonly");
      const moderator = await fx.player("mod", "moderator");
      await steamBan(gameOnly, { game: 1, daysAgo: 4 });
      await steamBan(vacAuto, { vac: 1, daysAgo: 4 });
      await sanction(vacAuto, { hoursAgo: 4 * 24 - 2 });
      await sanction(staffOnly, { by: moderator, hoursAgo: 5 });

      expect(ids(await list({ status: "not_banned_here" }))).toEqual([
        gameOnly,
      ]);
      const [row] = await list({ status: "not_banned_here" });
      expect(row.sanction_id).toBeNull();
      expect(row.sanction_kind).toBeNull();
    });
  });

  describe("history here", () => {
    it("counts matches, the last map and matches since the Steam ban", async () => {
      const banned = await fx.player("gamebanned");
      const other = await fx.player("other");
      await steamBan(banned, { game: 1, daysAgo: 5 });
      await match({
        lineup1: [banned],
        lineup2: [other],
        daysAgo: 10,
        map: "de_inferno",
      });
      await match({
        lineup1: [banned],
        lineup2: [other],
        daysAgo: 3,
        map: "de_nuke",
      });
      await match({
        lineup1: [other],
        lineup2: [banned],
        daysAgo: 1,
        map: "de_ancient",
      });

      const [row] = await list();
      expect(row.matches_played).toBe(3);
      expect(row.matches_since_steam_ban).toBe(2);
      expect(row.last_match_map).toBe("de_ancient");
      expect(row.arrived_banned).toBe(false);
      expect(row.first_match_at!.getTime()).toBeLessThan(
        row.last_match_at!.getTime(),
      );
    });

    it("flags a player whose Steam ban predates their first match here", async () => {
      const arrived = await fx.player("arrived");
      const fresh = await fx.player("fresh");
      const other = await fx.player("other");
      await steamBan(arrived, { vac: 2, game: 1, daysAgo: 1400 });
      await match({ lineup1: [arrived], lineup2: [other], daysAgo: 2 });
      await sanction(arrived, { hoursAgo: 36 });
      await steamBan(fresh, { vac: 1, daysAgo: 1 });
      await match({ lineup1: [fresh], lineup2: [other], daysAgo: 6 });
      await sanction(fresh, { hoursAgo: 20 });

      const rows = await list();
      const byId = new Map(rows.map((row) => [String(row.steam_id), row]));
      expect(byId.get(arrived)!.arrived_banned).toBe(true);
      expect(byId.get(arrived)!.banned_at_source).toBe("5stack");
      expect(byId.get(fresh)!.arrived_banned).toBe(false);

      expect(ids(await list({ timing: "arrived_banned" }))).toEqual([arrived]);
      expect(ids(await list({ timing: "played_first" }))).toEqual([fresh]);
    });

    it("counts from the newest ban of the kinds asked for", async () => {
      const both = await fx.player("bothkinds");
      const other = await fx.player("other");
      await steamBan(both, { vac: 1, game: 1, daysAgo: 2 });
      await banDates(both, 18, 2);
      await match({ lineup1: [both], lineup2: [other], daysAgo: 10 });
      await match({ lineup1: [both], lineup2: [other], daysAgo: 1 });

      const [vac] = await list({ kinds: ["vac"] });
      expect(vac.arrived_banned).toBe(true);
      expect(vac.matches_since_steam_ban).toBe(2);
      expect(
        ids(await list({ kinds: ["vac"], timing: "arrived_banned" })),
      ).toEqual([both]);

      const [anyKind] = await list();
      expect(anyKind.arrived_banned).toBe(false);
      expect(anyKind.matches_since_steam_ban).toBe(1);
    });
  });

  describe("played with me", () => {
    let viewer: string;
    let opponentLost: string;
    let teammate: string;
    let opponentWon: string;
    let stranger: string;

    beforeEach(async () => {
      const moderator = await fx.player("mod", "moderator");
      const filler = await fx.player("filler");
      viewer = await fx.player("viewer");
      opponentLost = await fx.player("cheater");
      teammate = await fx.player("mate");
      opponentWon = await fx.player("gameban");
      stranger = await fx.player("stranger");

      // Lost 9-13 to the cheater on Mirage, won with the teammate, beat the
      // game-banned player.
      await match({
        lineup1: [viewer],
        lineup2: [opponentLost],
        daysAgo: 1,
        winner: 2,
        score: [9, 13],
      });
      await match({
        lineup1: [viewer, teammate],
        lineup2: [filler],
        daysAgo: 3,
        winner: 1,
        score: [13, 7],
        map: "de_ancient",
      });
      await match({
        lineup1: [opponentWon],
        lineup2: [viewer],
        daysAgo: 5,
        winner: 2,
        score: [10, 13],
        map: "de_anubis",
      });

      // Banned after the matches: a banned player can't join a lineup.
      await steamBan(opponentLost, { vac: 1, daysAgo: 0 });
      await sanction(opponentLost, { hoursAgo: 3 });
      await sanction(teammate, { by: moderator, hoursAgo: 13 });
      await steamBan(opponentWon, { game: 1, daysAgo: 2 });
      await sanction(stranger, { by: moderator, hoursAgo: 30 });
    });

    it("either side keeps everyone the viewer played with", async () => {
      expect(
        new Set(ids(await listAs(viewer, { playedWith: "either" }))),
      ).toEqual(new Set([opponentLost, teammate, opponentWon]));
    });

    it("splits opponents from teammates", async () => {
      expect(
        new Set(ids(await listAs(viewer, { playedWith: "opponent" }))),
      ).toEqual(new Set([opponentLost, opponentWon]));
      expect(ids(await listAs(viewer, { playedWith: "teammate" }))).toEqual([
        teammate,
      ]);
    });

    it("lost only keeps the matches the viewer lost, from the viewer's side", async () => {
      const rows = await listAs(viewer, { lostOnly: true });
      expect(ids(rows)).toEqual([opponentLost]);
      expect(rows[0].shared_matches).toHaveLength(1);
      expect(rows[0].shared_matches![0]).toMatchObject({
        map: "de_mirage",
        viewer_score: 9,
        other_score: 13,
        won: false,
        side: "opponent",
      });
    });

    it("scores from the viewer's side when the viewer is lineup 2", async () => {
      const [row] = await listAs(viewer, { search: "gameban" });
      expect(row.shared_matches).toEqual([
        expect.objectContaining({
          map: "de_anubis",
          viewer_score: 13,
          other_score: 10,
          won: true,
          side: "opponent",
        }),
      ]);
    });

    it("without a filter, attaches shared matches to every row and [] when none", async () => {
      const rows = await listAs(viewer);
      const byId = new Map(rows.map((row) => [String(row.steam_id), row]));
      expect(byId.size).toBe(4);
      expect(byId.get(teammate)!.shared_matches![0].side).toBe("teammate");
      expect(byId.get(stranger)!.shared_matches).toEqual([]);
    });

    it("gives guests no shared matches and nothing for a played-with filter", async () => {
      const rows = await list();
      expect(rows.length).toBe(4);
      expect(rows.every((row) => row.shared_matches === null)).toBe(true);
      expect(await list({ playedWith: "either" })).toEqual([]);
      expect(await list({ lostOnly: true })).toEqual([]);
    });

    it("falls back to the session Hasura set on the connection", async () => {
      const rows = await runAsUser(postgres, viewer, "user", (query) =>
        query(SQL, params({ playedWith: "teammate" }, null)),
      );
      expect((rows as Array<Entry>).map((row) => String(row.steam_id))).toEqual(
        [teammate],
      );
    });
  });

  describe("search", () => {
    it("matches part of a name, any case, or an exact steam id", async () => {
      const moderator = await fx.player("mod", "moderator");
      const kow = await fx.player("xX_Kowalczyk_Xx");
      const other = await fx.player("someone");
      await sanction(kow, { by: moderator, hoursAgo: 2 });
      await sanction(other, { by: moderator, hoursAgo: 2 });

      expect(ids(await list({ search: "kowal" }))).toEqual([kow]);
      expect(ids(await list({ search: "  KOWAL " }))).toEqual([kow]);
      expect(ids(await list({ search: other }))).toEqual([other]);
      expect(ids(await list({ search: "100%_" }))).toEqual([]);
    });
  });
});
