import { Logger } from "@nestjs/common";
import { PostgresService } from "../src/postgres/postgres.service";
import { SteamBansService } from "../src/steam-match-history/steam-bans.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// GetPlayerBans never says which game a VAC ban is for, so a ban issued before
// CS:GO's closed beta (2011-11-30) has to belong to some other game and must not
// keep anyone off a CS2 platform.
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
      "DELETE FROM settings WHERE name = 'public.sanction_vac_ban_scope'",
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const daysSince = (date: string) =>
    Math.floor((Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);

  const service = () =>
    new SteamBansService(
      new Logger("SteamBansTest"),
      postgres,
      { get: () => "test-steam-key" } as never,
      { getConnection: () => ({}) } as never,
      {} as never,
    );

  const steamReports = (steamId: string, lastBanOn: string) => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            players: [
              {
                SteamId: steamId,
                CommunityBanned: false,
                VACBanned: true,
                NumberOfVACBans: 1,
                DaysSinceLastBan: daysSince(lastBanOn),
                NumberOfGameBans: 0,
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
    ["2011-11-25", 0],
    ["2011-12-05", 1],
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

  it("lifts an existing auto-ban whose VAC ban predates CS:GO", async () => {
    const player = await fx.player();
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, reason)
       VALUES ($1::bigint, 'ban', NULL, 'Auto: Steam 1 VAC ban(s), last 7209d ago')`,
      [player],
    );
    steamReports(player, "2007-01-25");

    await service().checkPlayers([player]);

    expect(await activeBans(player)).toBe(0);
  });

  it("keeps a pre-CS:GO VAC ban out of a scoped cooldown", async () => {
    const oldBan = await fx.player();
    const csgoBan = await fx.player();
    await postgres.query(
      `INSERT INTO settings (name, value) VALUES ('public.sanction_vac_ban_scope', 'matchmaking')`,
    );
    await postgres.query(
      `UPDATE players
          SET vac_banned = true,
              vac_ban_count = 1,
              days_since_last_ban = CASE WHEN steam_id = $1::bigint THEN $3::int ELSE $4::int END
        WHERE steam_id IN ($1::bigint, $2::bigint)`,
      [oldBan, csgoBan, daysSince("2007-01-25"), daysSince("2024-02-09")],
    );

    const expiry = async (steamId: string) => {
      const [row] = await postgres.query<Array<{ expiry: string | null }>>(
        `SELECT public.player_sanction_expiry($1::bigint, 'matchmaking')::text AS expiry`,
        [steamId],
      );
      return row.expiry;
    };

    expect(await expiry(oldBan)).toBeNull();
    expect(await expiry(csgoBan)).toBe("infinity");
  });
});
