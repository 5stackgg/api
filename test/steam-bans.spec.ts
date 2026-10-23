import { readFileSync } from "fs";
import { join } from "path";
import { Logger } from "@nestjs/common";
import { PostgresService } from "../src/postgres/postgres.service";
import { SteamBansService } from "../src/steam-match-history/steam-bans.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// GetPlayerBans never says which game a VAC ban is for, so only a ban issued
// since CS2's limited test (2023-03-22) keeps anyone off the platform.
describe("steam bans", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    db = await bootMigratedDb("SteamBansTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196200000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      `DELETE FROM settings
        WHERE name IN ('public.sanction_vac_ban_scope', 'public.sanction_vac_ban_enabled')`,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const daysSince = (date: string) =>
    Math.floor((Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);

  const today = () => new Date().toISOString().slice(0, 10);

  const service = () =>
    new SteamBansService(
      new Logger("SteamBansTest"),
      postgres,
      { get: () => "test-steam-key" } as never,
      { getConnection: () => ({}) } as never,
      {} as never,
    );

  const steamReports = (
    steamId: string,
    lastBanOn: string,
    vacBans = 1,
    gameBans = 0,
  ) => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            players: [
              {
                SteamId: steamId,
                CommunityBanned: false,
                VACBanned: vacBans > 0,
                NumberOfVACBans: vacBans,
                DaysSinceLastBan:
                  vacBans + gameBans > 0 ? daysSince(lastBanOn) : 0,
                NumberOfGameBans: gameBans,
                EconomyBan: "none",
              },
            ],
          }),
        ),
    ) as never;
  };

  const activeBans = async (steamId: string) => {
    const [row] = await postgres.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count
         FROM player_sanctions
        WHERE player_steam_id = $1::bigint
          AND type = 'ban'
          AND deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())`,
      [steamId],
    );
    return row.count;
  };

  it.each([
    ["2007-01-25", 0],
    ["2016-09-01", 0],
    ["2023-03-21", 0],
    ["2023-03-22", 1],
    ["2024-02-09", 1],
  ])(
    "a VAC ban last issued on %s leaves %i active auto-ban(s)",
    async (lastBanOn, expected) => {
      const player = await fx.player();
      steamReports(player, lastBanOn);

      await service().checkPlayers([player]);

      expect(await activeBans(player)).toBe(expected);
    },
  );

  const ban = (
    steamId: string,
    sanctionedBy: string | null = null,
    reason = sanctionedBy ? "banned" : "Auto: Steam 1 VAC ban(s), last 1d ago",
  ) =>
    postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, reason)
       VALUES ($1::bigint, 'ban', $2::bigint, $3)`,
      [steamId, sanctionedBy, reason],
    );

  it("lifts an existing auto-ban whose VAC ban predates CS2", async () => {
    const player = await fx.player();
    await ban(player);
    steamReports(player, "2016-09-01");

    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(0);
  });

  it.each([
    ["2023-03-21", 0],
    ["2023-03-22", 1],
  ])(
    "an existing auto-ban for a VAC ban last issued on %s leaves %i active",
    async (lastBanOn, expected) => {
      const player = await fx.player();
      await ban(player);
      steamReports(player, lastBanOn);

      await service().checkPlayers([player]);

      expect(await activeBans(player)).toBe(expected);
    },
  );

  it("keeps a pre-CS2 VAC ban lifted when a game ban lands later", async () => {
    const player = await fx.player();
    await ban(player);
    steamReports(player, "2016-09-01");
    await service().checkPlayers([player]);

    steamReports(player, today(), 1, 1);
    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(0);
  });

  it("bans a player who first shows up with both kinds when the newest is from CS2", async () => {
    const player = await fx.player();
    steamReports(player, "2024-02-09", 1, 1);

    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(1);
  });

  it("dates a new VAC ban from the check that finds it", async () => {
    const player = await fx.player();
    steamReports(player, "2016-09-01");
    await service().checkPlayers([player]);
    expect(await activeBans(player)).toBe(0);

    steamReports(player, "2025-01-01", 2);
    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(1);
  });

  it("keeps a removed auto-ban removed when a game ban lands later", async () => {
    const player = await fx.player();
    steamReports(player, "2024-02-09");
    await service().checkPlayers([player]);
    await postgres.query(
      `UPDATE player_sanctions SET deleted_at = '2025-06-01' WHERE player_steam_id = $1::bigint`,
      [player],
    );

    steamReports(player, today(), 1, 1);
    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(0);
    const [row] = await postgres.query<Array<{ vac_banned: boolean }>>(
      `SELECT vac_banned FROM players WHERE steam_id = $1::bigint`,
      [player],
    );
    expect(row.vac_banned).toBe(false);
  });

  it.each([["2025-02-20"], [null]])(
    "corrects a stored VAC date of %s from Steam's next reading",
    async (stored) => {
      const player = await fx.player();
      await postgres.query(
        `UPDATE players
            SET vac_banned = true, vac_ban_count = 1, last_vac_ban_at = $2::timestamptz
          WHERE steam_id = $1::bigint`,
        [player, stored],
      );
      await ban(player);
      steamReports(player, "2021-05-01");

      await service().checkPlayers([player]);

      expect(await activeBans(player)).toBe(0);
    },
  );

  it("keeps the VAC date when Valve reverses one of the VAC bans", async () => {
    const player = await fx.player();
    await ban(player);
    steamReports(player, "2016-09-01", 2);
    await service().checkPlayers([player]);
    steamReports(player, today(), 2, 1);
    await service().checkPlayers([player]);

    steamReports(player, today(), 1, 1);
    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(0);
  });

  it("gives the VAC ban's own age in the reason", async () => {
    const player = await fx.player();
    steamReports(player, "2024-02-09");
    await service().checkPlayers([player]);
    await postgres.query(
      `UPDATE player_sanctions SET remove_sanction_date = now() - interval '1 day'
        WHERE player_steam_id = $1::bigint`,
      [player],
    );

    steamReports(player, today(), 1, 1);
    await service().checkPlayers([player]);

    const [row] = await postgres.query<Array<{ reason: string }>>(
      `SELECT reason FROM player_sanctions
        WHERE player_steam_id = $1::bigint
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())`,
      [player],
    );
    expect(row.reason).toBe(
      `Auto: Steam 1 VAC ban(s), last ${daysSince("2024-02-09")}d ago`,
    );
  });

  it("leaves an expired staff ban whose issuer is gone as it was", async () => {
    const player = await fx.player();
    await postgres.query(
      `INSERT INTO player_sanctions
          (player_steam_id, type, sanctioned_by_steam_id, reason, remove_sanction_date)
       VALUES ($1::bigint, 'ban', NULL, 'griefing', '2025-01-01')`,
      [player],
    );
    steamReports(player, "2024-02-09");

    await service().checkPlayers([player]);

    const rows = await postgres.query<
      Array<{ reason: string; remove_sanction_date: Date | null }>
    >(
      `SELECT reason, remove_sanction_date FROM player_sanctions
        WHERE player_steam_id = $1::bigint
        ORDER BY created_at`,
      [player],
    );
    expect(rows.map((r) => r.reason)).toEqual([
      "griefing",
      `Auto: Steam 1 VAC ban(s), last ${daysSince("2024-02-09")}d ago`,
    ]);
    expect(rows[0].remove_sanction_date?.toISOString()).toBe(
      "2025-01-01T00:00:00.000Z",
    );
    expect(await activeBans(player)).toBe(1);
  });

  it("keeps each kind's date when a ban of the other kind lands", async () => {
    const player = await fx.player();
    steamReports(player, "2016-09-01", 0, 1);
    await service().checkPlayers([player]);

    steamReports(player, "2024-02-09", 1, 1);
    await service().checkPlayers([player]);

    const [row] = await postgres.query<
      Array<{ vac: string | null; game: string | null }>
    >(
      `SELECT (last_vac_ban_at AT TIME ZONE 'UTC')::date::text AS vac,
              (last_game_ban_at AT TIME ZONE 'UTC')::date::text AS game
         FROM players WHERE steam_id = $1::bigint`,
      [player],
    );
    expect(row).toEqual({ vac: "2024-02-09", game: "2016-09-01" });
  });

  it("dates a new game ban from the check that finds it", async () => {
    const player = await fx.player();
    steamReports(player, "2016-09-01", 0, 1);
    await service().checkPlayers([player]);

    steamReports(player, "2025-01-01", 0, 2);
    await service().checkPlayers([player]);

    const [row] = await postgres.query<Array<{ game: string | null }>>(
      `SELECT (last_game_ban_at AT TIME ZONE 'UTC')::date::text AS game
         FROM players WHERE steam_id = $1::bigint`,
      [player],
    );
    expect(row.game).toBe("2025-01-01");
  });

  it("lifts an auto-ban once Steam no longer reports a VAC ban", async () => {
    const player = await fx.player();
    await ban(player);
    steamReports(player, "2024-02-09", 0);

    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(0);
  });

  it("keeps a CS2-era auto-ban with enforcement switched off", async () => {
    const player = await fx.player();
    await ban(player);
    await postgres.query(
      `INSERT INTO settings (name, value) VALUES ('public.sanction_vac_ban_enabled', 'false')`,
    );
    steamReports(player, "2024-02-09");

    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(1);
  });

  it("never lifts a staff ban on a player whose VAC ban predates CS2", async () => {
    const staff = await fx.player(undefined, "administrator");
    const player = await fx.player();
    await ban(player, staff);
    steamReports(player, "2016-09-01");

    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(1);
  });

  it("never lifts a staff ban whose issuer is gone", async () => {
    const player = await fx.player();
    await ban(player, null, "griefing");
    steamReports(player, "2016-09-01");

    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(1);
  });

  it("keeps a pre-CS2 VAC ban out of a scoped cooldown", async () => {
    const oldBan = await fx.player();
    const cs2Ban = await fx.player();
    const staleOldBan = await fx.player();
    await postgres.query(
      `INSERT INTO settings (name, value) VALUES ('public.sanction_vac_ban_scope', 'matchmaking')`,
    );
    await postgres.query(
      `UPDATE players
          SET vac_banned = true,
              vac_ban_count = 1,
              days_since_last_ban = CASE WHEN steam_id = $1::bigint THEN $3::int ELSE $4::int END
        WHERE steam_id IN ($1::bigint, $2::bigint)`,
      [oldBan, cs2Ban, daysSince("2016-09-01"), daysSince("2024-02-09")],
    );
    await postgres.query(
      `UPDATE players
          SET vac_banned = true,
              vac_ban_count = 1,
              days_since_last_ban = '2026-08-20'::date - '2023-02-20'::date,
              steam_bans_checked_at = '2026-08-20'
        WHERE steam_id = $1::bigint`,
      [staleOldBan],
    );

    const expiry = async (steamId: string) => {
      const [row] = await postgres.query<Array<{ expiry: string | null }>>(
        `SELECT public.player_sanction_expiry($1::bigint, 'matchmaking')::text AS expiry`,
        [steamId],
      );
      return row.expiry;
    };

    expect(await expiry(oldBan)).toBeNull();
    expect(await expiry(cs2Ban)).toBe("infinity");
    expect(await expiry(staleOldBan)).toBeNull();
  });

  describe("lifting auto-bans already issued before the cutoff moved to CS2", () => {
    const up = readFileSync(
      join(
        __dirname,
        "../hasura/migrations/default/1890000001330_vac_bans_cs2_cutoff/up.sql",
      ),
      "utf8",
    );

    const steamChecked = (
      steamId: string,
      lastBanOn: string,
      checkedOn: string | null,
    ) =>
      postgres.query(
        `UPDATE players
            SET vac_banned = true,
                vac_ban_count = 1,
                days_since_last_ban = COALESCE($3::date, now()::date) - $2::date,
                steam_bans_checked_at = $3::date
          WHERE steam_id = $1::bigint`,
        [steamId, lastBanOn, checkedOn],
      );

    it("lifts an auto-ban for a pre-CS2 VAC ban, dated from when Steam was asked", async () => {
      const preCs2 = await fx.player();
      const neverRechecked = await fx.player();
      const cs2 = await fx.player();
      const staffBanned = await fx.player();
      const issuerGone = await fx.player();
      const staff = await fx.player(undefined, "administrator");
      await steamChecked(preCs2, "2023-03-10", "2023-04-01");
      await steamChecked(neverRechecked, "2016-09-01", null);
      await steamChecked(cs2, "2023-03-24", "2023-04-01");
      await steamChecked(staffBanned, "2016-09-01", "2025-01-01");
      await steamChecked(issuerGone, "2016-09-01", "2025-01-01");
      await ban(preCs2);
      await ban(neverRechecked);
      await ban(cs2);
      await ban(staffBanned, staff);
      await ban(issuerGone, null, "griefing");

      await postgres.query(up);

      expect(await activeBans(preCs2)).toBe(0);
      expect(await activeBans(neverRechecked)).toBe(0);
      expect(await activeBans(cs2)).toBe(1);
      expect(await activeBans(staffBanned)).toBe(1);
      expect(await activeBans(issuerGone)).toBe(1);
    });
  });
});
