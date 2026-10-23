import { Logger } from "@nestjs/common";
import { PostgresService } from "../src/postgres/postgres.service";
import {
  FaceitBan,
  FaceitBansService,
} from "../src/faceit/faceit-bans.service";
import { SteamBansService } from "../src/steam-match-history/steam-bans.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("faceit bans", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    db = await bootMigratedDb("FaceitBansTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196300000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      `DELETE FROM settings
        WHERE name IN ('public.sanction_faceit_ban_scope', 'public.sanction_faceit_ban_enabled')`,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const service = () =>
    new FaceitBansService(new Logger("FaceitBansTest"), postgres, {
      get: () => "test-faceit-key",
    } as never);

  const days = (count: number) =>
    new Date(Date.now() + count * 86_400_000).toISOString();

  const cheating = (ends_at: string | null = days(700)): FaceitBan => ({
    reason: "cheating",
    starts_at: days(-30),
    ends_at,
  });

  const faceitReports = (
    bans: Array<FaceitBan> | number,
    accounts: Record<string, number> = { cs2: 200 },
  ) => {
    const fetch = jest.fn(async (url: string) => {
      const game = new URL(url).searchParams.get("game");
      if (game) {
        const status = accounts[game] ?? 404;
        return new Response(
          JSON.stringify(status === 200 ? { player_id: "faceit-id" } : {}),
          { status },
        );
      }
      if (typeof bans === "number") {
        return new Response("{}", { status: bans });
      }
      return new Response(JSON.stringify({ items: bans }));
    });
    global.fetch = fetch as never;
    return fetch;
  };

  const activeBans = async (steamId: string) =>
    postgres.query<
      Array<{ reason: string; remove_sanction_date: Date | null }>
    >(
      `SELECT reason, remove_sanction_date
         FROM player_sanctions
        WHERE player_steam_id = $1::bigint
          AND type = 'ban'
          AND deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())`,
      [steamId],
    );

  const recheck = (steamId: string) =>
    postgres.query(
      "UPDATE players SET faceit_bans_checked_at = NULL WHERE steam_id = $1::bigint",
      [steamId],
    );

  it("bans a player FACEIT has banned for cheating until FACEIT's ban ends", async () => {
    const player = await fx.player();
    const endsAt = days(700);
    faceitReports([cheating(endsAt)]);

    await service().checkPlayer(player);

    const bans = await activeBans(player);
    expect(bans).toHaveLength(1);
    expect(bans[0].reason).toBe("Auto: FACEIT cheating ban");
    expect(bans[0].remove_sanction_date?.toISOString()).toBe(endsAt);
  });

  it("bans for good when FACEIT's cheating ban never ends", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);

    await service().checkPlayer(player);

    const bans = await activeBans(player);
    expect(bans).toHaveLength(1);
    expect(bans[0].remove_sanction_date).toBeNull();
  });

  it.each([
    [
      "a ban for something other than cheating",
      [{ reason: "multiple accounts", starts_at: days(-30), ends_at: null }],
    ],
    ["a cheating ban that has ended", [cheating(days(-1))]],
    ["no bans", []],
  ])("leaves a player with %s alone", async (_label, bans) => {
    const player = await fx.player();
    faceitReports(bans);

    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(0);
  });

  it("finds an account that only has a CS:GO profile", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)], { csgo: 200 });

    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(1);
  });

  it("lifts the auto-ban once FACEIT no longer reports the cheating ban", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);

    await recheck(player);
    faceitReports([]);
    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(0);
  });

  it("keeps the ban when FACEIT cannot be asked", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);

    await recheck(player);
    faceitReports(503);
    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(1);
    const [row] = await postgres.query<Array<{ checked: Date | null }>>(
      "SELECT faceit_bans_checked_at AS checked FROM players WHERE steam_id = $1::bigint",
      [player],
    );
    expect(row.checked).toBeNull();
  });

  it("asks FACEIT at most once an hour per player", async () => {
    const player = await fx.player();
    faceitReports([]);
    await service().checkPlayer(player);

    const fetch = faceitReports([cheating(null)]);
    await service().checkPlayer(player);

    expect(fetch).not.toHaveBeenCalled();
    expect(await activeBans(player)).toHaveLength(0);
  });

  it("keeps a removed auto-ban removed, until FACEIT bans the player again", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);
    await postgres.query(
      "UPDATE player_sanctions SET deleted_at = $2 WHERE player_steam_id = $1::bigint",
      [player, days(-10)],
    );

    await recheck(player);
    await service().checkPlayer(player);
    expect(await activeBans(player)).toHaveLength(0);

    await recheck(player);
    faceitReports([
      cheating(null),
      { reason: "cheating", starts_at: days(-1), ends_at: null },
    ]);
    await service().checkPlayer(player);
    expect(await activeBans(player)).toHaveLength(1);
  });

  it("reuses the player's lifted auto-ban when FACEIT bans them again", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);
    await recheck(player);
    faceitReports([]);
    await service().checkPlayer(player);

    await recheck(player);
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);

    const [row] = await postgres.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM player_sanctions WHERE player_steam_id = $1::bigint",
      [player],
    );
    expect(row.count).toBe(1);
    expect(await activeBans(player)).toHaveLength(1);
  });

  it.each([
    ["public.sanction_faceit_ban_enabled", "false"],
    ["public.sanction_faceit_ban_scope", "matchmaking"],
  ])("writes no ban with %s set to %s", async (name, value) => {
    const player = await fx.player();
    await postgres.query("INSERT INTO settings (name, value) VALUES ($1, $2)", [
      name,
      value,
    ]);
    faceitReports([cheating(null)]);

    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(0);
  });

  it("never bans an administrator", async () => {
    const player = await fx.player(undefined, "administrator");
    faceitReports([cheating(null)]);

    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(0);
  });

  it("never lifts a staff ban", async () => {
    const staff = await fx.player(undefined, "administrator");
    const player = await fx.player();
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, reason)
       VALUES ($1::bigint, 'ban', $2::bigint, 'cheating')`,
      [player, staff],
    );
    faceitReports([]);

    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(1);
  });

  it("removing a FACEIT auto-ban does not excuse a VAC ban", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);
    await postgres.query(
      "UPDATE player_sanctions SET deleted_at = now() WHERE player_steam_id = $1::bigint",
      [player],
    );

    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            players: [
              {
                SteamId: player,
                CommunityBanned: false,
                VACBanned: true,
                NumberOfVACBans: 1,
                DaysSinceLastBan: 30,
                NumberOfGameBans: 0,
                EconomyBan: "none",
              },
            ],
          }),
        ),
    ) as never;
    await new SteamBansService(
      new Logger("FaceitBansTest"),
      postgres,
      { get: () => "test-steam-key" } as never,
      { getConnection: () => ({}) } as never,
      {} as never,
    ).checkPlayers([player]);

    const bans = await activeBans(player);
    expect(bans).toHaveLength(1);
    expect(bans[0].reason).toMatch(/^Auto: Steam/);
    const [row] = await postgres.query<Array<{ vac_banned: boolean }>>(
      "SELECT vac_banned FROM players WHERE steam_id = $1::bigint",
      [player],
    );
    expect(row.vac_banned).toBe(true);
  });
});
