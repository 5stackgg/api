import { PostgresService } from "../src/postgres/postgres.service";
import { StreamAccessService } from "../src/matches/game-streamer/stream-access.service";
import { TwitchAccountsService } from "../src/twitch/twitch-accounts.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The anti-ghosting rule: nobody sharing a Live match with a player -- on
// either lineup, or coaching -- may see that player's stream through any of the
// Twitch reads. A guest could be one of them signed out, so while streams
// require a login, guests see nobody who is in a Live match.
describe("twitch streams", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let serverId: string;
  let configured: boolean;
  let liveStreams: jest.Mock;
  let users: jest.Mock;
  let accounts: TwitchAccountsService;
  let outsider: string;

  const redisStore = new Map<string, string>();

  beforeAll(async () => {
    db = await bootMigratedDb("TwitchStreamsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561192700000000n);
    await fx.region();
    [{ id: serverId }] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM servers WHERE label = 'TestA-server'",
    );
    outsider = await fx.player("Outsider");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    configured = true;
    liveStreams = jest.fn();
    users = jest.fn(async (): Promise<Array<unknown>> => []);
    redisStore.clear();

    accounts = new TwitchAccountsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {
        get: () => ({
          webDomain: "https://5stack.gg",
          apiDomain: "https://api.5stack.gg",
          authCookieDomain: ".5stack.gg",
        }),
      } as any,
      postgres,
      {
        getConnection: () => ({
          set: async (key: string, value: string) => {
            redisStore.set(key, value);
            return "OK";
          },
          del: async () => 1,
          eval: async () => 1,
        }),
      } as any,
      {
        credentials: async () =>
          configured ? { clientId: "id", clientSecret: "secret" } : null,
        liveStreams,
        users,
      } as any,
      new StreamAccessService(postgres),
    );

    await postgres.query("DELETE FROM player_twitch_accounts");
    await postgres.query("DELETE FROM settings WHERE name = $1", [
      "public.require_login_for_live_streams",
    ]);
  });

  // Bypasses the match lifecycle triggers, which would demand a real veto and
  // server boot to reach Live.
  const stage = async (
    matchId: string,
    status: string,
    { online = true, source = "5stack" } = {},
  ) => {
    await postgres.transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("UPDATE servers SET connected = $2 WHERE id = $1", [
        serverId,
        online,
      ]);
      await client.query(
        "UPDATE matches SET status = $2, server_id = $3, source = $4 WHERE id = $1",
        [matchId, status, serverId, source],
      );
    });
  };

  const liveMatch = async (
    options: { online?: boolean; source?: string } = {},
  ) => {
    const { matchId } = await fx.bareMatch();
    const [lineups] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >("SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [matchId]);

    const streamer = await fx.lineupPlayer(lineups.lineup_1_id);
    const teammate = await fx.lineupPlayer(lineups.lineup_1_id);
    const opponent = await fx.lineupPlayer(lineups.lineup_2_id);
    const coach = await fx.player("Coach");
    await postgres.query(
      "UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1",
      [lineups.lineup_2_id, coach],
    );

    await stage(matchId, "Live", options);

    return { matchId, ...lineups, streamer, teammate, opponent, coach };
  };

  const goLive = (
    steamId: string,
    {
      login = `login${steamId}`,
      checkedAgo = "1 minute",
      viewers = 10,
    }: { login?: string; checkedAgo?: string; viewers?: number } = {},
  ) =>
    postgres.query(
      `INSERT INTO player_twitch_accounts
         (steam_id, twitch_user_id, login, display_name, is_live, stream_title,
          game_name, viewer_count, started_at, thumbnail_url, checked_at)
       VALUES ($1::bigint, $1::text, $2::text, upper($2::text), true, 'title',
               'Counter-Strike', $3, now() - interval '1 hour', 'https://thumb',
               now() - $4::interval)`,
      [steamId, login, viewers, checkedAgo],
    );

  const peers = async (steamId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT live_match_peers::text AS steam_id FROM live_match_peers($1) ORDER BY 1",
        [steamId],
      )
    ).map(({ steam_id }) => steam_id);

  describe("live_match_peers", () => {
    it("is both lineups and both coaches of a Live match", async () => {
      const match = await liveMatch();
      const otherCoach = await fx.player("OtherCoach");
      await postgres.query(
        "UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1",
        [match.lineup_1_id, otherCoach],
      );

      const everyone = [
        match.streamer,
        match.teammate,
        match.opponent,
        match.coach,
        otherCoach,
      ].sort();

      for (const member of everyone) {
        expect(await peers(member)).toEqual(everyone);
      }
    });

    it("is nobody for a player outside any Live match", async () => {
      await liveMatch();

      expect(await peers(await fx.player("Outsider"))).toEqual([]);
    });

    it.each(["Veto", "WaitingForServer", "Finished", "Canceled"])(
      "is nobody once the match is %s",
      async (status) => {
        const match = await liveMatch();
        await stage(match.matchId, status);

        expect(await peers(match.opponent)).toEqual([]);
      },
    );

    it("leaves practice sessions out", async () => {
      const match = await liveMatch({ source: "practice" });

      expect(await peers(match.streamer)).toEqual([]);
    });
  });

  describe("reads", () => {
    it("hide a live stream from everyone in the streamer's Live match", async () => {
      const match = await liveMatch();
      await goLive(match.streamer);

      for (const viewer of [match.teammate, match.opponent, match.coach]) {
        expect(await accounts.liveSteamIds(viewer)).toEqual([]);
        expect(await accounts.player(match.streamer, viewer)).toBeNull();
        expect(await accounts.matchStreams(match.matchId, viewer)).toEqual([]);
      }
    });

    it("show it to everyone else who is signed in", async () => {
      const match = await liveMatch();
      await goLive(match.streamer, { login: "seated" });
      await postgres.query(
        "UPDATE players SET custom_avatar_url = 'avatars/seated.png' WHERE steam_id = $1",
        [match.streamer],
      );

      expect(await accounts.liveSteamIds(outsider)).toEqual([match.streamer]);
      expect(await accounts.player(match.streamer, outsider)).toEqual({
        steam_id: match.streamer,
        login: "seated",
        display_name: "SEATED",
        is_live: true,
        title: "title",
        game_name: "Counter-Strike",
        viewer_count: 10,
        started_at: expect.any(Date),
        thumbnail_url: "https://thumb",
      });
      expect(await accounts.matchStreams(match.matchId, outsider)).toEqual([
        {
          steam_id: match.streamer,
          name: expect.any(String),
          avatar_url: "https://api.5stack.gg/avatars/seated.png",
          match_lineup_id: match.lineup_1_id,
          login: "seated",
          display_name: "SEATED",
          title: "title",
          viewer_count: 10,
          started_at: expect.any(Date),
          thumbnail_url: "https://thumb",
        },
      ]);
    });

    // A guest may be a player of the match signed out, or curl.
    it("hide everyone in a Live match from guests while streams require a login", async () => {
      const match = await liveMatch();
      const elsewhere = await fx.player("NotPlaying");
      for (const steamId of [match.streamer, match.coach, elsewhere]) {
        await goLive(steamId);
      }

      expect(await accounts.liveSteamIds()).toEqual([elsewhere]);
      expect(await accounts.player(match.streamer)).toBeNull();
      expect(await accounts.player(match.coach)).toBeNull();
      expect(await accounts.player(elsewhere)).toEqual(
        expect.objectContaining({ steam_id: elsewhere, is_live: true }),
      );
      expect(await accounts.matchStreams(match.matchId)).toEqual([]);
    });

    it("show guests a practice server's host", async () => {
      const practice = await liveMatch({ source: "practice" });
      await goLive(practice.streamer);

      expect(await accounts.liveSteamIds()).toEqual([practice.streamer]);
    });

    it("show guests everything once streams no longer require a login", async () => {
      const match = await liveMatch();
      await goLive(match.streamer);
      await postgres.query(
        "INSERT INTO settings (name, value) VALUES ('public.require_login_for_live_streams', 'false')",
      );

      expect(await accounts.liveSteamIds()).toEqual([match.streamer]);
      expect(await accounts.player(match.streamer)).toEqual(
        expect.objectContaining({ steam_id: match.streamer }),
      );
      expect(
        (await accounts.matchStreams(match.matchId)).map(
          ({ steam_id }) => steam_id,
        ),
      ).toEqual([match.streamer]);

      expect(await accounts.liveSteamIds(match.opponent)).toEqual([]);
    });

    it("show a malformed viewer nothing", async () => {
      const match = await liveMatch();
      await goLive(match.streamer);

      for (const viewer of ["abc", "99999999999999999999"]) {
        expect(await accounts.liveSteamIds(viewer)).toEqual([]);
        expect(await accounts.player(match.streamer, viewer)).toBeNull();
        expect(await accounts.matchStreams(match.matchId, viewer)).toEqual([]);
      }
    });

    it("answer a steam id too large for the column with nothing", async () => {
      expect(await accounts.player("99999999999999999999")).toBeNull();
    });

    it("show it to the match's players again once it is over", async () => {
      const match = await liveMatch();
      await goLive(match.streamer);
      await stage(match.matchId, "Finished");

      expect(await accounts.liveSteamIds(match.opponent)).toEqual([
        match.streamer,
      ]);
    });

    it("only hide the streams of the viewer's own match", async () => {
      const mine = await liveMatch();
      const theirs = await liveMatch();
      await goLive(mine.streamer, { viewers: 5 });
      await goLive(theirs.streamer, { viewers: 50 });

      expect(await accounts.liveSteamIds(mine.opponent)).toEqual([
        theirs.streamer,
      ]);
      expect(await accounts.liveSteamIds(outsider)).toEqual([
        theirs.streamer,
        mine.streamer,
      ]);
    });

    it("stop believing a live flag the poller has not confirmed lately", async () => {
      const match = await liveMatch();
      await goLive(match.streamer, { checkedAgo: "11 minutes" });

      expect(await accounts.liveSteamIds(outsider)).toEqual([]);
      expect(await accounts.matchStreams(match.matchId, outsider)).toEqual([]);
      expect(await accounts.player(match.streamer, outsider)).toEqual(
        expect.objectContaining({
          is_live: false,
          title: null,
          viewer_count: null,
          thumbnail_url: null,
        }),
      );
    });

    it("show no match POVs before the match's server is up", async () => {
      const match = await liveMatch({ online: false });
      await goLive(match.streamer);

      expect(await accounts.matchStreams(match.matchId, outsider)).toEqual([]);
    });

    it("show no match POVs outside a Live match", async () => {
      const match = await liveMatch();
      await goLive(match.streamer);

      for (const status of ["Veto", "WaitingForServer", "Finished"]) {
        await stage(match.matchId, status);
        expect(await accounts.matchStreams(match.matchId, outsider)).toEqual(
          [],
        );
      }
    });

    it("only make POVs of the match's own lineups", async () => {
      const match = await liveMatch();
      await goLive(await fx.player("StreamerElsewhere"));
      await goLive(match.coach);

      expect(await accounts.matchStreams(match.matchId, outsider)).toEqual([]);
    });

    it("show nothing while Twitch is not configured", async () => {
      const match = await liveMatch();
      await goLive(match.streamer);
      configured = false;

      expect(await accounts.liveSteamIds(outsider)).toEqual([]);
      expect(await accounts.player(match.streamer, outsider)).toBeNull();
      expect(await accounts.matchStreams(match.matchId, outsider)).toEqual([]);
    });

    it("show the player their own account during their own match", async () => {
      const match = await liveMatch();
      await goLive(match.streamer, { login: "me" });

      expect(await accounts.me(match.streamer)).toEqual({
        enabled: true,
        account: expect.objectContaining({ login: "me", is_live: true }),
      });
    });
  });

  describe("linking", () => {
    const user = (id: string, login = `login${id}`) => ({
      id,
      login,
      display_name: login.toUpperCase(),
    });

    const account = async (steamId: string) =>
      (
        await postgres.query<
          Array<{ twitch_user_id: string; login: string; is_live: boolean }>
        >(
          "SELECT twitch_user_id, login, is_live FROM player_twitch_accounts WHERE steam_id = $1",
          [steamId],
        )
      )[0];

    it("refuses a Twitch account another player has, keeping the player's own", async () => {
      const first = await fx.player("First");
      const second = await fx.player("Second");

      expect(await accounts.link(first, user("100"))).toBe(true);
      expect(await accounts.link(second, user("200"))).toBe(true);
      expect(await accounts.link(second, user("100"))).toBe(false);

      expect(await account(first)).toEqual(
        expect.objectContaining({ twitch_user_id: "100" }),
      );
      expect(await account(second)).toEqual(
        expect.objectContaining({ twitch_user_id: "200" }),
      );
    });

    it("replaces a player's account, live state and all", async () => {
      const player = await fx.player("Switcher");
      await goLive(player);

      expect(await accounts.link(player, user("300", "renamed"))).toBe(true);

      expect(await account(player)).toEqual({
        twitch_user_id: "300",
        login: "renamed",
        is_live: false,
      });
    });

    it("keeps the live state when the same account is linked again", async () => {
      const player = await fx.player("Relinker");
      await goLive(player);

      expect(await accounts.link(player, user(player, "newname"))).toBe(true);

      expect(await account(player)).toEqual({
        twitch_user_id: player,
        login: "newname",
        is_live: true,
      });
    });
  });

  describe("the poller", () => {
    it("writes what Twitch reports onto the linked accounts", async () => {
      const live = await fx.player("Live");
      const other = await fx.player("OtherGame");
      const offline = await fx.player("Offline");
      for (const steamId of [live, other, offline]) {
        await goLive(steamId);
      }

      liveStreams.mockResolvedValueOnce([
        {
          user_id: live,
          user_login: "renamed",
          user_name: "Renamed",
          game_id: "32399",
          game_name: "Counter-Strike",
          type: "live",
          title: "ranked grind",
          viewer_count: 321,
          started_at: "2026-10-14T10:00:00Z",
          thumbnail_url: "https://thumb/{width}x{height}.jpg",
        },
        {
          user_id: other,
          user_login: "other",
          user_name: "Other",
          game_id: "509658",
          game_name: "Just Chatting",
          type: "live",
          title: "chatting",
          viewer_count: 9,
          started_at: "2026-10-14T10:00:00Z",
          thumbnail_url: "https://thumb/{width}x{height}.jpg",
        },
      ]);

      await accounts.pollLiveStatus();

      const rows = await postgres.query<
        Array<Record<string, unknown> & { steam_id: string }>
      >(
        `SELECT steam_id::text, login, is_live, stream_title, game_name, viewer_count,
                started_at, thumbnail_url, checked_at > now() - interval '1 minute' AS checked
           FROM player_twitch_accounts ORDER BY steam_id`,
      );
      const byId = Object.fromEntries(rows.map((row) => [row.steam_id, row]));

      expect(byId[live]).toEqual({
        steam_id: live,
        login: "renamed",
        is_live: true,
        stream_title: "ranked grind",
        game_name: "Counter-Strike",
        viewer_count: 321,
        started_at: new Date("2026-10-14T10:00:00Z"),
        thumbnail_url: "https://thumb/640x360.jpg",
        checked: true,
      });

      for (const steamId of [other, offline]) {
        expect(byId[steamId]).toEqual(
          expect.objectContaining({
            is_live: false,
            stream_title: null,
            game_name: null,
            viewer_count: null,
            started_at: null,
            thumbnail_url: null,
            checked: true,
          }),
        );
      }
    });

    it("refreshes an offline channel's name", async () => {
      const player = await fx.player("Renamer");
      await accounts.link(player, {
        id: "500",
        login: "oldname",
        display_name: "OldName",
      });
      liveStreams.mockResolvedValueOnce([]);
      users.mockResolvedValueOnce([
        { id: "500", login: "newname", display_name: "NewName" },
      ]);

      await accounts.pollLiveStatus();

      expect(users).toHaveBeenCalledWith(expect.anything(), ["500"]);
      const [row] = await postgres.query<
        Array<{ login: string; display_name: string; is_live: boolean }>
      >(
        "SELECT login, display_name, is_live FROM player_twitch_accounts WHERE steam_id = $1",
        [player],
      );
      expect(row).toEqual({
        login: "newname",
        display_name: "NewName",
        is_live: false,
      });
    });

    it("leaves every account as it was when Twitch fails", async () => {
      const player = await fx.player("Kept");
      await goLive(player, { checkedAgo: "2 minutes" });
      liveStreams.mockRejectedValueOnce(new Error("twitch helix answered 503"));

      await accounts.pollLiveStatus();

      const [row] = await postgres.query<
        Array<{ is_live: boolean; recent: boolean }>
      >(
        `SELECT is_live, checked_at > now() - interval '1 minute' AS recent
           FROM player_twitch_accounts WHERE steam_id = $1`,
        [player],
      );
      expect(row).toEqual({ is_live: true, recent: false });
    });
  });
});
