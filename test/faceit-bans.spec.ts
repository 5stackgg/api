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
    await fx.region();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM match_lineup_players");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      `DELETE FROM settings
        WHERE name LIKE 'public.sanction\\_faceit\\_ban\\_%'`,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const service = () =>
    new FaceitBansService(
      new Logger("FaceitBansTest"),
      postgres,
      { get: () => "test-faceit-key" } as never,
      queue as never,
    );

  const queue = { addBulk: jest.fn(async (): Promise<Array<unknown>> => []) };
  const FACEIT_URL = "https://www.faceit.com/en/players/cheater";

  const days = (count: number) =>
    new Date(Date.now() + count * 86_400_000).toISOString();

  const cheating = (ends_at: string | null = days(700)): FaceitBan => ({
    reason: "cheating",
    starts_at: days(-30),
    ends_at,
  });

  const faceitReports = (
    bans: Array<FaceitBan> | number | "no list",
    accounts: Record<string, number> = { cs2: 200 },
  ) => {
    const fetch = jest.fn(async (url: string) => {
      const game = new URL(url).searchParams.get("game");
      if (game) {
        const status = accounts[game] ?? 404;
        return new Response(
          JSON.stringify(
            status === 200
              ? {
                  player_id: "faceit-id",
                  faceit_url: "https://www.faceit.com/{lang}/players/cheater",
                }
              : {},
          ),
          { status },
        );
      }
      if (typeof bans === "number") {
        return new Response("{}", { status: bans });
      }
      if (bans === "no list") {
        return new Response("{}");
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

  it("writes the FACEIT ban beside an active VAC ban", async () => {
    const player = await fx.player();
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, reason)
       VALUES ($1::bigint, 'ban', NULL, 'Auto: Steam 1 VAC ban(s), last 30d ago')`,
      [player],
    );
    faceitReports([cheating(null)]);

    await service().checkPlayer(player);

    expect((await activeBans(player)).map((ban) => ban.reason).sort()).toEqual([
      "Auto: FACEIT cheating ban",
      "Auto: Steam 1 VAC ban(s), last 30d ago",
    ]);
  });

  it("moves the ban's end when FACEIT makes it permanent", async () => {
    const player = await fx.player();
    faceitReports([cheating(days(100))]);
    await service().checkPlayer(player);

    await recheck(player);
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);

    const bans = await activeBans(player);
    expect(bans).toHaveLength(1);
    expect(bans[0].remove_sanction_date).toBeNull();
  });

  it.each([
    ["the FACEIT account can no longer be found", "no account"],
    ["the account lookup fails", "lookup fails"],
    ["FACEIT answers without a ban list", "no list"],
  ])("keeps the ban when %s", async (_label, failure) => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);

    await recheck(player);
    if (failure === "no account") {
      faceitReports([], {});
    } else if (failure === "lookup fails") {
      faceitReports([], { cs2: 503 });
    } else {
      faceitReports("no list");
    }
    await service().checkPlayer(player);

    expect(await activeBans(player)).toHaveLength(1);
  });

  it("ends the ban at the policy's ladder when that comes before FACEIT's end", async () => {
    const player = await fx.player();
    await postgres.query(
      "INSERT INTO settings (name, value) VALUES ('public.sanction_faceit_ban_durations', '1440')",
    );
    const startsAt = new Date(Date.now() - 3_600_000);
    faceitReports([
      {
        reason: "cheating",
        starts_at: startsAt.toISOString(),
        ends_at: days(700),
      },
    ]);

    await service().checkPlayer(player);

    const bans = await activeBans(player);
    expect(bans).toHaveLength(1);
    expect(bans[0].remove_sanction_date?.toISOString()).toBe(
      new Date(startsAt.getTime() + 86_400_000).toISOString(),
    );
  });

  it("keeps a moderator's end date until FACEIT changes the ban", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);
    await postgres.query(
      "UPDATE player_sanctions SET remove_sanction_date = now() - interval '1 minute' WHERE player_steam_id = $1::bigint",
      [player],
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

  it("writes a VAC ban beside an active FACEIT ban", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)]);
    await service().checkPlayer(player);

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

    expect((await activeBans(player)).map((ban) => ban.reason).sort()).toEqual([
      "Auto: FACEIT cheating ban",
      "Auto: Steam 1 VAC ban(s), last 30d ago",
    ]);
  });

  it("ends a narrowed cooldown when FACEIT's ban ends", async () => {
    const player = await fx.player();
    await postgres.query(
      "INSERT INTO settings (name, value) VALUES ('public.sanction_faceit_ban_scope', 'matchmaking')",
    );
    const endsAt = days(30);
    faceitReports([cheating(endsAt)]);

    await service().checkPlayer(player);

    const [row] = await postgres.query<Array<{ expiry: Date | null }>>(
      "SELECT public.player_sanction_expiry($1::bigint, 'matchmaking') AS expiry",
      [player],
    );
    expect(row.expiry?.toISOString()).toBe(endsAt);
  });

  it("keeps the FACEIT profile link the account lookup found", async () => {
    const player = await fx.player();
    faceitReports([cheating(null)], { csgo: 200 });

    await service().checkPlayer(player);

    const [row] = await postgres.query<Array<{ faceit_url: string | null }>>(
      "SELECT faceit_url FROM players WHERE steam_id = $1::bigint",
      [player],
    );
    expect(row.faceit_url).toBe(FACEIT_URL);
  });

  it("queues players who played since their last check, and every active player daily", async () => {
    const neverChecked = await fx.player();
    const checkedSinceMatch = await fx.player();
    const playedSinceCheck = await fx.player();
    const checkedLongAgo = await fx.player();
    const inactive = await fx.player();
    await postgres.query(
      `UPDATE players SET faceit_bans_checked_at = CASE
         WHEN steam_id = $1::bigint THEN now() - interval '2 hours'
         WHEN steam_id = $2::bigint THEN now() - interval '2 hours'
         WHEN steam_id = $3::bigint THEN now() - interval '2 days'
         ELSE now() - interval '2 days'
       END
       WHERE steam_id IN ($1::bigint, $2::bigint, $3::bigint, $4::bigint)`,
      [checkedSinceMatch, playedSinceCheck, checkedLongAgo, inactive],
    );

    const play = async (steamId: string, createdAt: string) => {
      const { matchId } = await fx.bareMatch();
      const [match] = await postgres.query<Array<{ lineup_1_id: string }>>(
        "UPDATE matches SET created_at = now() - $2::interval WHERE id = $1 RETURNING lineup_1_id",
        [matchId, createdAt],
      );
      await fx.lineupPlayer(match.lineup_1_id, steamId);
    };
    await play(neverChecked, "1 day");
    await play(checkedSinceMatch, "3 hours");
    await play(playedSinceCheck, "1 hour");
    await play(checkedLongAgo, "30 days");
    queue.addBulk.mockClear();

    await service().queueStaleChecks();

    const jobs = (queue.addBulk.mock.calls[0] as any)[0] as Array<{
      data: { steamId: string };
      opts: { priority?: number };
    }>;
    expect(jobs.map((job) => job.data.steamId).sort()).toEqual(
      [neverChecked, playedSinceCheck, checkedLongAgo].sort(),
    );
    expect(jobs.every((job) => job.opts.priority === 10)).toBe(true);
  });
});
