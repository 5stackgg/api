import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// The configurable sanctions policy, against a real database.
//
// The most important thing here is the first block: the shipped defaults must
// reproduce, exactly, what the platform did when these numbers were hardcoded --
// the 7 day windowed escalating leaver cooldown and the permanent platform-wide
// VAC ban. If that drifts, an upgrade silently re-sentences everybody.
describe("sanctions policy (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  // The ladder that lived in get_player_matchmaking_cooldown before the policy
  // existed, in minutes, indexed by abandon count.
  const HARDCODED_LADDER = [10, 60, 120, 240, 480, 960, 1920];

  beforeAll(async () => {
    db = await bootMigratedDb("SanctionsPolicyTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196100000000n);
    await fx.region("TestSanctions");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM abandoned_matches");
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "DELETE FROM settings WHERE name LIKE 'public.sanction\\_%'",
    );
    await reseedPolicySettings();
  });

  // The same statement HasuraService.updateSettings() runs at boot.
  const reseedPolicySettings = () =>
    postgres.query(
      `insert into settings (name, value)
       select 'public.sanction_' || value || '_enabled', default_enabled::text from e_sanction_sources
       union all
       select 'public.sanction_' || value || '_threshold', default_threshold::text from e_sanction_sources
       union all
       select 'public.sanction_' || value || '_window_days', default_window_days::text from e_sanction_sources
       union all
       select 'public.sanction_' || value || '_durations', default_durations from e_sanction_sources
       union all
       select 'public.sanction_' || value || '_scope', default_scope from e_sanction_sources
       on conflict (name) do nothing`,
    );

  const setSetting = (name: string, value: string) =>
    postgres.query(
      "INSERT INTO settings (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = $2",
      [name, value],
    );

  const abandon = (steamId: string, agoInterval = "0 seconds") =>
    postgres.query(
      `INSERT INTO abandoned_matches (steam_id, abandoned_at)
       VALUES ($1::bigint, now() - $2::interval)`,
      [steamId, agoInterval],
    );

  const createTournament = async (
    start = "1 day",
    { type = "Competitive", checkIn = false } = {},
  ) => {
    const organizer = await fx.player();
    const options = await fx.matchOptions({
      type,
      regions: ["TestSanctions"],
    });
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments
         (name, start, organizer_steam_id, match_options_id, status, check_in_required)
       VALUES ($1, now() + $2::interval, $3::bigint, $4::uuid, 'Setup', $5) RETURNING id`,
      [fx.nextName("cup"), start, organizer, options, checkIn],
    );
    return tournament.id;
  };

  // Stamping check_in_ends_at is what ProcessTournamentCheckIn does to open the
  // window; record_tournament_no_shows refuses to record anything without it.
  const openCheckInWindow = (tournamentId: string) =>
    postgres.query(
      "UPDATE tournaments SET check_in_ends_at = now() - interval '1 minute' WHERE id = $1::uuid",
      [tournamentId],
    );

  const registerTeam = async (tournamentId: string, players: Array<string>) => {
    const [team] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
       VALUES ($1::uuid, $2, $3::bigint, $3::bigint) RETURNING id`,
      [tournamentId, fx.nextName("roster"), players[0]],
    );

    for (const player of players) {
      // tbi_tournament_team_roster reads hasura.user unconditionally, so a
      // roster insert has to arrive with a session like a real request.
      await runAsUser(postgres, player, "admin", (query) =>
        query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1::uuid, $2::bigint, $3::uuid) ON CONFLICT DO NOTHING`,
          [team.id, player, tournamentId],
        ),
      );
    }

    return team.id;
  };

  const recordNoShows = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ recorded: number }>>(
      "SELECT public.record_tournament_no_shows($1::uuid) AS recorded",
      [tournamentId],
    );
    return row.recorded;
  };

  // tournament_no_shows keys on a tournament, so each occurrence needs its own
  // one; the arithmetic under test only ever reads occurred_at.
  const noShow = async (steamId: string, agoInterval = "0 seconds") => {
    const tournamentId = await createTournament();
    await postgres.query(
      `INSERT INTO tournament_no_shows (tournament_id, player_steam_id, occurred_at)
       VALUES ($1::uuid, $2::bigint, now() - $3::interval)`,
      [tournamentId, steamId, agoInterval],
    );
    return tournamentId;
  };

  const expiry = async (
    steamId: string,
    scope: "matchmaking" | "tournaments",
  ) => {
    const [row] = await postgres.query<Array<{ expiry: Date | null }>>(
      "SELECT public.player_sanction_expiry($1::bigint, $2) AS expiry",
      [steamId, scope],
    );
    return row.expiry;
  };

  const matchmakingCooldown = (steamId: string) =>
    runAsUser(postgres, steamId, "user", async (query) => {
      const rows = (await query(
        `SELECT public.get_player_matchmaking_cooldown(p, $1::json) AS cooldown
           FROM players p WHERE p.steam_id = $2::bigint`,
        [
          JSON.stringify({
            "x-hasura-user-id": steamId,
            "x-hasura-role": "user",
          }),
          steamId,
        ],
      )) as Array<{ cooldown: Date | null }>;
      return rows[0].cooldown;
    });

  const minutesBetween = (from: Date, to: Date) =>
    Math.round((to.getTime() - from.getTime()) / 60000);

  describe("shipped defaults reproduce the previous hardcoded behaviour", () => {
    // Pins the settings inventory the web app builds its Sanctions page from,
    // name for name and value for value. A rename here is a broken UI there.
    it("seeds exactly the documented settings", async () => {
      const rows = await postgres.query<Array<{ name: string; value: string }>>(
        "SELECT name, value FROM settings WHERE name LIKE 'public.sanction\\_%' ORDER BY name",
      );

      expect(
        Object.fromEntries(rows.map((row) => [row.name, row.value])),
      ).toEqual({
        "public.sanction_match_abandon_enabled": "true",
        "public.sanction_match_abandon_threshold": "1",
        "public.sanction_match_abandon_window_days": "7",
        "public.sanction_match_abandon_durations": "10,60,120,240,480,960,1920",
        "public.sanction_match_abandon_scope": "matchmaking",
        "public.sanction_vac_ban_enabled": "true",
        "public.sanction_vac_ban_threshold": "1",
        "public.sanction_vac_ban_window_days": "0",
        "public.sanction_vac_ban_durations": "0",
        "public.sanction_vac_ban_scope": "both",
        "public.sanction_tournament_no_show_enabled": "true",
        "public.sanction_tournament_no_show_threshold": "3",
        "public.sanction_tournament_no_show_window_days": "30",
        "public.sanction_tournament_no_show_durations": "10080",
        "public.sanction_tournament_no_show_scope": "tournaments",
      });
    });

    it("ships the scopes the settings page offers", async () => {
      const rows = await postgres.query<Array<{ value: string }>>(
        "SELECT value FROM e_sanction_scopes ORDER BY value",
      );

      expect(rows.map((row) => row.value)).toEqual([
        "both",
        "matchmaking",
        "tournaments",
      ]);
    });

    it("ships the sources the platform actually has", async () => {
      const rows = await postgres.query<Array<{ value: string }>>(
        "SELECT value FROM e_sanction_sources ORDER BY value",
      );

      expect(rows.map((row) => row.value)).toEqual([
        "match_abandon",
        "tournament_no_show",
        "vac_ban",
      ]);
    });

    it("reproduces the hardcoded leaver ladder rung for rung", async () => {
      const player = await fx.player();

      for (let count = 1; count <= HARDCODED_LADDER.length; count++) {
        await abandon(player);

        const [row] = await postgres.query<Array<{ last_abandoned_at: Date }>>(
          "SELECT MAX(abandoned_at) AS last_abandoned_at FROM abandoned_matches WHERE steam_id = $1::bigint",
          [player],
        );

        const cooldown = await matchmakingCooldown(player);

        expect(cooldown).not.toBeNull();
        expect(minutesBetween(row.last_abandoned_at, cooldown!)).toBe(
          HARDCODED_LADDER[count - 1],
        );
      }
    });

    it("clamps past the end of the ladder instead of escalating forever", async () => {
      const player = await fx.player();

      for (let i = 0; i < HARDCODED_LADDER.length + 3; i++) {
        await abandon(player);
      }

      const [row] = await postgres.query<Array<{ last_abandoned_at: Date }>>(
        "SELECT MAX(abandoned_at) AS last_abandoned_at FROM abandoned_matches WHERE steam_id = $1::bigint",
        [player],
      );

      const cooldown = await matchmakingCooldown(player);

      expect(minutesBetween(row.last_abandoned_at, cooldown!)).toBe(1920);
    });

    it("forgives abandons older than the 7 day window", async () => {
      const player = await fx.player();

      await abandon(player, "8 days");
      await abandon(player, "9 days");
      await abandon(player, "10 days");

      expect(await matchmakingCooldown(player)).toBeNull();

      // A fresh one is a first offence again, not a fourth.
      await abandon(player);

      const cooldown = await matchmakingCooldown(player);
      const [row] = await postgres.query<Array<{ last_abandoned_at: Date }>>(
        "SELECT MAX(abandoned_at) AS last_abandoned_at FROM abandoned_matches WHERE steam_id = $1::bigint",
        [player],
      );

      expect(minutesBetween(row.last_abandoned_at, cooldown!)).toBe(10);
    });

    it("still hides another player's cooldown from the session", async () => {
      const player = await fx.player();
      const other = await fx.player();

      await abandon(player);

      const cooldown = await runAsUser(
        postgres,
        other,
        "user",
        async (query) => {
          const rows = (await query(
            `SELECT public.get_player_matchmaking_cooldown(p, $1::json) AS cooldown
             FROM players p WHERE p.steam_id = $2::bigint`,
            [
              JSON.stringify({
                "x-hasura-user-id": other,
                "x-hasura-role": "user",
              }),
              player,
            ],
          )) as Array<{ cooldown: Date | null }>;
          return rows[0].cooldown;
        },
      );

      expect(cooldown).toBeNull();
    });

    it("keeps the leaver cooldown off the tournaments surface", async () => {
      const player = await fx.player();

      await abandon(player);

      expect(await expiry(player, "matchmaking")).not.toBeNull();
      expect(await expiry(player, "tournaments")).toBeNull();
    });

    it("keeps a platform-wide VAC ban out of the matchmaking cooldown", async () => {
      const player = await fx.player();

      await postgres.query(
        `UPDATE players SET vac_banned = true, vac_ban_count = 1, days_since_last_ban = 3
          WHERE steam_id = $1::bigint`,
        [player],
      );

      // is_banned() is what enforces it; a cooldown with an end date would be a
      // lie about a ban that has none.
      expect(await matchmakingCooldown(player)).toBeNull();
      expect(await expiry(player, "tournaments")).toBeNull();
    });

    it("resolves the VAC ban as permanent, which player_sanctions spells as NULL", async () => {
      const player = await fx.player();

      await postgres.query(
        `UPDATE players SET vac_banned = true, vac_ban_count = 2, days_since_last_ban = 40
          WHERE steam_id = $1::bigint`,
        [player],
      );

      const [row] = await postgres.query<
        Array<{ raw: string | null; remove_date: Date | null }>
      >(
        `SELECT public.player_source_sanction_expiry('vac_ban', $1::bigint)::text AS raw,
                public.sanction_remove_date('vac_ban', 1, now()) AS remove_date`,
        [player],
      );

      expect(row.raw).toBe("infinity");
      expect(row.remove_date).toBeNull();
    });
  });

  describe("threshold and window arithmetic", () => {
    it("does not punish a first or second tournament no-show", async () => {
      const player = await fx.player();

      await noShow(player);
      expect(await expiry(player, "tournaments")).toBeNull();

      await noShow(player);
      expect(await expiry(player, "tournaments")).toBeNull();
    });

    it("bans for 7 days on the third no-show, counted from the last one", async () => {
      const player = await fx.player();

      await noShow(player, "10 days");
      await noShow(player, "5 days");
      await noShow(player);

      const [row] = await postgres.query<Array<{ last_at: Date }>>(
        "SELECT MAX(occurred_at) AS last_at FROM tournament_no_shows WHERE player_steam_id = $1::bigint",
        [player],
      );

      const tournaments = await expiry(player, "tournaments");

      expect(tournaments).not.toBeNull();
      expect(minutesBetween(row.last_at, tournaments!)).toBe(7 * 24 * 60);
    });

    it("never touches matchmaking for a tournament no-show", async () => {
      const player = await fx.player();

      await noShow(player);
      await noShow(player);
      await noShow(player);

      expect(await expiry(player, "tournaments")).not.toBeNull();
      expect(await expiry(player, "matchmaking")).toBeNull();
      expect(await matchmakingCooldown(player)).toBeNull();
    });

    it("decays no-shows out of the 30 day window", async () => {
      const player = await fx.player();

      await noShow(player, "40 days");
      await noShow(player, "35 days");
      await noShow(player, "31 days");

      expect(await expiry(player, "tournaments")).toBeNull();
    });

    it("honours an edited window", async () => {
      const player = await fx.player();

      await abandon(player, "10 days");
      await abandon(player);

      const lastAbandon = async () => {
        const [row] = await postgres.query<Array<{ last_at: Date }>>(
          "SELECT MAX(abandoned_at) AS last_at FROM abandoned_matches WHERE steam_id = $1::bigint",
          [player],
        );
        return row.last_at;
      };

      // The shipped 7 day window sees one abandon: first rung.
      expect(
        minutesBetween(
          await lastAbandon(),
          (await matchmakingCooldown(player))!,
        ),
      ).toBe(10);

      await setSetting("public.sanction_match_abandon_window_days", "30");

      // A 30 day window sees both: second rung.
      expect(
        minutesBetween(
          await lastAbandon(),
          (await matchmakingCooldown(player))!,
        ),
      ).toBe(60);
    });

    it("honours an edited threshold", async () => {
      const player = await fx.player();

      await setSetting("public.sanction_match_abandon_threshold", "3");

      await abandon(player);
      expect(await matchmakingCooldown(player)).toBeNull();

      await abandon(player);
      expect(await matchmakingCooldown(player)).toBeNull();

      await abandon(player);
      expect(await matchmakingCooldown(player)).not.toBeNull();
    });

    it("honours an edited ladder", async () => {
      const player = await fx.player();

      await setSetting("public.sanction_match_abandon_durations", "5,15");
      await abandon(player);

      const first = await matchmakingCooldown(player);
      const [firstRow] = await postgres.query<Array<{ last_at: Date }>>(
        "SELECT MAX(abandoned_at) AS last_at FROM abandoned_matches WHERE steam_id = $1::bigint",
        [player],
      );
      expect(minutesBetween(firstRow.last_at, first!)).toBe(5);

      await abandon(player);

      const second = await matchmakingCooldown(player);
      const [secondRow] = await postgres.query<Array<{ last_at: Date }>>(
        "SELECT MAX(abandoned_at) AS last_at FROM abandoned_matches WHERE steam_id = $1::bigint",
        [player],
      );
      expect(minutesBetween(secondRow.last_at, second!)).toBe(15);
    });

    it("honours an edited scope", async () => {
      const player = await fx.player();

      await abandon(player);
      expect(await expiry(player, "tournaments")).toBeNull();

      await setSetting("public.sanction_match_abandon_scope", "both");

      expect(await expiry(player, "tournaments")).not.toBeNull();
      expect(await expiry(player, "matchmaking")).not.toBeNull();
    });

    it("clamps a nonsense threshold rather than banning everyone", async () => {
      await setSetting("public.sanction_match_abandon_threshold", "0");

      const [row] = await postgres.query<Array<{ threshold: number }>>(
        "SELECT public.sanction_policy_threshold('match_abandon') AS threshold",
      );

      expect(row.threshold).toBe(1);
    });

    it("falls back to the shipped values when a settings row is garbage", async () => {
      await setSetting(
        "public.sanction_match_abandon_durations",
        "not,minutes",
      );
      await setSetting("public.sanction_match_abandon_threshold", "abc");
      await setSetting("public.sanction_match_abandon_scope", "everywhere");

      const [row] = await postgres.query<
        Array<{ durations: Array<number>; threshold: number; scope: string }>
      >(
        `SELECT public.sanction_policy_durations('match_abandon') AS durations,
                public.sanction_policy_threshold('match_abandon') AS threshold,
                public.sanction_policy_scope('match_abandon') AS scope`,
      );

      expect(row.durations).toEqual(HARDCODED_LADDER);
      expect(row.threshold).toBe(1);
      expect(row.scope).toBe("matchmaking");
    });

    it("falls back to the shipped values when the settings rows are missing entirely", async () => {
      const player = await fx.player();

      await postgres.query(
        "DELETE FROM settings WHERE name LIKE 'public.sanction\\_%'",
      );

      await abandon(player);

      const cooldown = await matchmakingCooldown(player);
      const [row] = await postgres.query<Array<{ last_at: Date }>>(
        "SELECT MAX(abandoned_at) AS last_at FROM abandoned_matches WHERE steam_id = $1::bigint",
        [player],
      );

      expect(minutesBetween(row.last_at, cooldown!)).toBe(10);
    });
  });

  describe("a disabled sanction never fires", () => {
    it("stops the leaver cooldown dead", async () => {
      const player = await fx.player();

      for (let i = 0; i < 5; i++) {
        await abandon(player);
      }

      expect(await matchmakingCooldown(player)).not.toBeNull();

      await setSetting("public.sanction_match_abandon_enabled", "false");

      expect(await matchmakingCooldown(player)).toBeNull();
      expect(await expiry(player, "matchmaking")).toBeNull();
    });

    it("stops the tournament no-show ban, however many occurrences", async () => {
      const player = await fx.player();

      await setSetting("public.sanction_tournament_no_show_enabled", "false");

      for (let i = 0; i < 10; i++) {
        await noShow(player);
      }

      expect(await expiry(player, "tournaments")).toBeNull();
    });

    it("records no occurrences at all once the no-show source is off", async () => {
      await setSetting("public.sanction_tournament_no_show_enabled", "false");

      const [row] = await postgres.query<Array<{ recorded: number }>>(
        "SELECT public.record_tournament_no_shows(gen_random_uuid()) AS recorded",
      );

      expect(row.recorded).toBe(0);
    });

    it("reports the VAC source as disabled to the ban service", async () => {
      await setSetting("public.sanction_vac_ban_enabled", "false");

      const [row] = await postgres.query<Array<{ enabled: boolean }>>(
        "SELECT COALESCE(public.sanction_policy_enabled('vac_ban'), true) AS enabled",
      );

      expect(row.enabled).toBe(false);
    });

    it("stops a disabled VAC source from resolving any ban date", async () => {
      const player = await fx.player();

      await postgres.query(
        `UPDATE players SET vac_banned = true, vac_ban_count = 1, days_since_last_ban = 1
          WHERE steam_id = $1::bigint`,
        [player],
      );

      await setSetting("public.sanction_vac_ban_enabled", "false");

      const [row] = await postgres.query<Array<{ resolved: Date | null }>>(
        "SELECT public.player_source_sanction_expiry('vac_ban', $1::bigint) AS resolved",
        [player],
      );

      expect(row.resolved).toBeNull();
    });
  });

  // The entry point ProcessTournamentCheckIn calls when a window closes:
  // SELECT public.record_tournament_no_shows($1::uuid)
  describe("recording tournament no-shows", () => {
    const wingmanCup = async () => {
      const tournamentId = await createTournament("1 day", {
        type: "Wingman",
        checkIn: true,
      });
      await openCheckInWindow(tournamentId);
      return tournamentId;
    };

    const occurrencesFor = async (steamId: string) => {
      const [row] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*)::text AS count FROM tournament_no_shows WHERE player_steam_id = $1::bigint",
        [steamId],
      );
      return Number(row.count);
    };

    it("records one occurrence per rostered player of a team that missed check-in", async () => {
      const tournamentId = await wingmanCup();
      const players = await fx.players(2);
      await registerTeam(tournamentId, players);

      expect(await recordNoShows(tournamentId)).toBe(2);

      for (const player of players) {
        expect(await occurrencesFor(player)).toBe(1);
      }
    });

    it("is idempotent, so a second close pass cannot double a ban", async () => {
      const tournamentId = await wingmanCup();
      const players = await fx.players(2);
      await registerTeam(tournamentId, players);

      expect(await recordNoShows(tournamentId)).toBe(2);
      expect(await recordNoShows(tournamentId)).toBe(0);
      expect(await occurrencesFor(players[0])).toBe(1);
    });

    it("leaves a team that checked in alone", async () => {
      const tournamentId = await wingmanCup();
      const players = await fx.players(2);
      const teamId = await registerTeam(tournamentId, players);

      await postgres.query(
        "UPDATE tournament_teams SET checked_in_at = now() WHERE id = $1::uuid",
        [teamId],
      );

      expect(await recordNoShows(tournamentId)).toBe(0);
    });

    it("leaves a roster that was never seedable alone", async () => {
      const tournamentId = await wingmanCup();
      const players = await fx.players(1);
      await registerTeam(tournamentId, players);

      expect(await recordNoShows(tournamentId)).toBe(0);
    });

    it("records nothing when the check-in window never opened", async () => {
      const tournamentId = await createTournament("1 day", {
        type: "Wingman",
        checkIn: true,
      });
      const players = await fx.players(2);
      await registerTeam(tournamentId, players);

      expect(await recordNoShows(tournamentId)).toBe(0);
    });

    it("records nothing for a tournament that does not exist", async () => {
      const [row] = await postgres.query<Array<{ recorded: number }>>(
        "SELECT public.record_tournament_no_shows(gen_random_uuid()) AS recorded",
      );

      expect(row.recorded).toBe(0);
    });

    it("bans the roster on the third tournament they no-show", async () => {
      const players = await fx.players(2);

      for (let i = 0; i < 3; i++) {
        const tournamentId = await wingmanCup();
        await registerTeam(tournamentId, players);
        await recordNoShows(tournamentId);
      }

      for (const player of players) {
        expect(await expiry(player, "tournaments")).not.toBeNull();
        expect(await expiry(player, "matchmaking")).toBeNull();
      }
    });

    it("exposes the ban through the player's own tournament_cooldown field", async () => {
      const players = await fx.players(2);

      for (let i = 0; i < 3; i++) {
        const tournamentId = await wingmanCup();
        await registerTeam(tournamentId, players);
        await recordNoShows(tournamentId);
      }

      const own = await runAsUser(
        postgres,
        players[0],
        "user",
        async (query) => {
          const rows = (await query(
            `SELECT public.get_player_tournament_cooldown(p, $1::json) AS cooldown
             FROM players p WHERE p.steam_id = $2::bigint`,
            [
              JSON.stringify({
                "x-hasura-user-id": players[0],
                "x-hasura-role": "user",
              }),
              players[0],
            ],
          )) as Array<{ cooldown: Date | null }>;
          return rows[0].cooldown;
        },
      );

      expect(own).not.toBeNull();

      const someoneElse = await runAsUser(
        postgres,
        players[1],
        "user",
        async (query) => {
          const rows = (await query(
            `SELECT public.get_player_tournament_cooldown(p, $1::json) AS cooldown
               FROM players p WHERE p.steam_id = $2::bigint`,
            [
              JSON.stringify({
                "x-hasura-user-id": players[1],
                "x-hasura-role": "user",
              }),
              players[0],
            ],
          )) as Array<{ cooldown: Date | null }>;
          return rows[0].cooldown;
        },
      );

      expect(someoneElse).toBeNull();
    });
  });

  describe("tournament join gate", () => {
    it("blocks a sanctioned player from joining and lets them back afterwards", async () => {
      const player = await fx.player();
      const tournamentId = await createTournament("2 days");

      const meets = async () => {
        const [row] = await postgres.query<Array<{ ok: boolean }>>(
          "SELECT player_meets_tournament_requirements($1::uuid, $2::bigint) AS ok",
          [tournamentId, player],
        );
        return row.ok;
      };

      expect(await meets()).toBe(true);

      await noShow(player);
      await noShow(player);
      await noShow(player);

      expect(await meets()).toBe(false);

      // Served: the last occurrence is older than the 7 day ban.
      await postgres.query(
        "UPDATE tournament_no_shows SET occurred_at = now() - interval '8 days' WHERE player_steam_id = $1::bigint",
        [player],
      );

      expect(await meets()).toBe(true);
    });
  });
});
