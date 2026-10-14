import { TwitchAccountsService } from "./twitch-accounts.service";

describe("TwitchAccountsService", () => {
  const CREDENTIALS = { clientId: "client-id", clientSecret: "client-secret" };
  const PLAYER = "76561198000000001";
  const OTHER = "76561198000000002";
  const MATCH = "00000000-0000-4000-8000-000000000000";

  let configured: boolean;
  let loginRequired: boolean;
  let cache: Map<string, string>;
  let service: TwitchAccountsService;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const config = {
    get: jest.fn(() => ({
      webDomain: "https://5stack.gg",
      apiDomain: "https://api.5stack.gg",
      authCookieDomain: ".5stack.gg",
    })),
  };

  const postgres = {
    query: jest.fn(),
    transaction: jest.fn(),
  };

  const redis = {
    get: jest.fn(async (key: string) => cache.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes("NX") && cache.has(key)) {
        return null;
      }
      cache.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (key: string) => (cache.delete(key) ? 1 : 0)),
    eval: jest.fn(
      async (_script: string, _keys: number, key: string, token: string) => {
        if (cache.get(key) === token) {
          cache.delete(key);
          return 1;
        }
        return 0;
      },
    ),
    multi: jest.fn(() => {
      const steps: Array<() => [null, unknown]> = [];
      const chain = {
        get: (key: string) => {
          steps.push(() => [null, cache.get(key) ?? null]);
          return chain;
        },
        del: (key: string) => {
          steps.push(() => [null, cache.delete(key) ? 1 : 0]);
          return chain;
        },
        exec: async () => steps.map((step) => step()),
      };
      return chain;
    }),
  };

  const twitch = {
    credentials: jest.fn(async () => (configured ? CREDENTIALS : null)),
    authorizeUrl: jest.fn(
      (_credentials: unknown, redirectUri: string, state: string) =>
        `https://id.twitch.tv/oauth2/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    ),
    exchangeCode: jest.fn(),
    authenticatedUser: jest.fn(),
    revokeToken: jest.fn(async (): Promise<void> => undefined),
    liveStreams: jest.fn(),
    users: jest.fn(),
  };

  const streamAccess = {
    requireLoginForLiveStreams: jest.fn(async () => loginRequired),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    configured = true;
    loginRequired = true;
    cache = new Map();
    postgres.query.mockResolvedValue([]);
    service = new TwitchAccountsService(
      logger as any,
      config as any,
      postgres as any,
      { getConnection: () => redis } as any,
      twitch as any,
      streamAccess as any,
    );
  });

  const query = (url: string) =>
    Object.fromEntries(new URL(url).searchParams.entries());

  describe("the live poller", () => {
    const linked = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        twitch_user_id: String(index + 1),
      }));

    const stream = (
      user_id: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: `stream-${user_id}`,
      user_id,
      user_login: `streamer${user_id}`,
      user_name: `Streamer${user_id}`,
      game_id: "32399",
      game_name: "Counter-Strike",
      type: "live",
      title: `title ${user_id}`,
      viewer_count: 12,
      started_at: "2026-10-14T10:00:00Z",
      thumbnail_url:
        "https://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-{width}x{height}.jpg",
      ...overrides,
    });

    const writes = (column: string) =>
      postgres.query.mock.calls
        .filter(([sql]) => sql.includes(`SET ${column} = v.${column}`))
        .map(([, [rows]]) => JSON.parse(rows));

    const updates = () => writes("is_live");

    const renames = () => writes("login");

    beforeEach(() => {
      postgres.query.mockImplementation(async (sql: string) =>
        sql.includes("SELECT twitch_user_id") ? linked(250) : [],
      );
      twitch.liveStreams.mockResolvedValue([]);
      twitch.users.mockImplementation(async (_credentials, ids: string[]) =>
        ids.map((id) => ({
          id,
          login: `renamed${id}`,
          display_name: `Renamed${id}`,
        })),
      );
    });

    it("asks Twitch about a hundred linked accounts at a time", async () => {
      await service.pollLiveStatus();

      expect(
        twitch.liveStreams.mock.calls.map(([, ids]) => ids.length),
      ).toEqual([100, 100, 50]);
      expect(twitch.liveStreams.mock.calls[2][1][0]).toBe("201");
      expect(updates().map((rows) => rows.length)).toEqual([100, 100, 50]);
    });

    it("records a Counter-Strike stream as live", async () => {
      twitch.liveStreams.mockResolvedValueOnce([stream("7")]);

      await service.pollLiveStatus();

      expect(
        updates()[0].find((row: any) => row.twitch_user_id === "7"),
      ).toEqual({
        twitch_user_id: "7",
        is_live: true,
        login: "streamer7",
        display_name: "Streamer7",
        title: "title 7",
        game_name: "Counter-Strike",
        viewer_count: 12,
        started_at: "2026-10-14T10:00:00Z",
        thumbnail_url:
          "https://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-640x360.jpg",
      });
      expect(
        updates()[0].find((row: any) => row.twitch_user_id === "8"),
      ).toEqual({
        twitch_user_id: "8",
        is_live: false,
      });
    });

    it("counts a stream in another category as not live", async () => {
      twitch.liveStreams.mockResolvedValueOnce([
        stream("7", { game_id: "509658", game_name: "Just Chatting" }),
      ]);

      await service.pollLiveStatus();

      expect(
        updates()[0].find((row: any) => row.twitch_user_id === "7"),
      ).toEqual({
        twitch_user_id: "7",
        is_live: false,
      });
    });

    it("accepts the category by name when the id is missing", async () => {
      twitch.liveStreams.mockResolvedValueOnce([stream("7", { game_id: "" })]);

      await service.pollLiveStatus();

      expect(
        updates()[0].find((row: any) => row.twitch_user_id === "7").is_live,
      ).toBe(true);
    });

    it("keeps the last known state when Twitch errors", async () => {
      twitch.liveStreams
        .mockResolvedValueOnce([stream("7")])
        .mockRejectedValueOnce(new Error("twitch helix answered 503"));

      await service.pollLiveStatus();

      expect(twitch.liveStreams).toHaveBeenCalledTimes(2);
      expect(updates()).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("keeping the last known state"),
      );
      expect(cache.has("twitch:poll-lock")).toBe(false);
    });

    it("does nothing until Twitch is configured", async () => {
      configured = false;

      await service.pollLiveStatus();

      expect(postgres.query).not.toHaveBeenCalled();
      expect(twitch.liveStreams).not.toHaveBeenCalled();
    });

    it("does not overlap a check that is still running", async () => {
      cache.set("twitch:poll-lock", "someone-else");

      await service.pollLiveStatus();

      expect(twitch.liveStreams).not.toHaveBeenCalled();
      expect(cache.get("twitch:poll-lock")).toBe("someone-else");
    });

    it("releases the lock when it is done", async () => {
      await service.pollLiveStatus();

      expect(cache.has("twitch:poll-lock")).toBe(false);
    });

    // An offline channel's login is otherwise only learned while it is live in
    // Counter-Strike, so a rename would leave the profile linking a dead login.
    it("refreshes every linked account's name once an hour", async () => {
      await service.pollLiveStatus();
      await service.pollLiveStatus();

      expect(twitch.users.mock.calls.map(([, ids]) => ids.length)).toEqual([
        100, 100, 50,
      ]);
      expect(renames().map((rows) => rows.length)).toEqual([100, 100, 50]);
      expect(renames()[0][0]).toEqual({
        twitch_user_id: "1",
        login: "renamed1",
        display_name: "Renamed1",
      });
      expect(redis.set).toHaveBeenCalledWith(
        "twitch:names-refreshed",
        "1",
        "EX",
        3600,
        "NX",
      );
    });

    it("tries the name refresh again next minute when Twitch fails it", async () => {
      twitch.users.mockRejectedValueOnce(
        new Error("twitch helix answered 503"),
      );

      await service.pollLiveStatus();
      await service.pollLiveStatus();

      expect(twitch.users).toHaveBeenCalledTimes(4);
      expect(renames().map((rows) => rows.length)).toEqual([100, 100, 50]);
    });

    it("leaves names alone while the stream check is failing", async () => {
      twitch.liveStreams.mockRejectedValueOnce(new Error("503"));

      await service.pollLiveStatus();

      expect(twitch.users).not.toHaveBeenCalled();
      expect(cache.has("twitch:names-refreshed")).toBe(false);
    });
  });

  describe("linking", () => {
    let linkQueries: Array<[string, Array<unknown>]>;

    const start = async (redirect?: unknown) => {
      const url = await service.startLink(PLAYER, redirect);
      return { url, state: query(url).state };
    };

    const finish = (
      steamId: string | undefined,
      params: Record<string, unknown>,
    ) => service.completeLink(steamId, params);

    beforeEach(() => {
      twitch.exchangeCode.mockResolvedValue("user-token");
      twitch.authenticatedUser.mockResolvedValue({
        id: "42",
        login: "streamer",
        display_name: "Streamer",
      });
      linkQueries = [];
      postgres.transaction.mockImplementation(async (fn: any) =>
        fn({
          query: jest.fn(async (sql: string, args: Array<unknown>) => {
            linkQueries.push([sql, args]);
          }),
        }),
      );
    });

    it("sends the player to Twitch with a state only it can finish", async () => {
      const { url, state } = await start("/settings/account");

      expect(query(url).redirect_uri).toBe(
        "https://5stack.gg/auth/twitch/callback",
      );
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.parse(cache.get(`twitch:oauth-state:${state}`))).toEqual({
        steam_id: PLAYER,
        redirect: "/settings/account",
      });
      expect(redis.set).toHaveBeenCalledWith(
        `twitch:oauth-state:${state}`,
        expect.any(String),
        "EX",
        600,
      );
    });

    it("refuses cleanly when Twitch is not configured", async () => {
      configured = false;

      const { url } = await start("/settings/account");

      expect(url).toBe(
        "https://5stack.gg/settings/account?twitch_error=not_configured",
      );
      expect(cache.size).toBe(0);
    });

    it.each([
      "https://evil.example/steal",
      "//evil.example/steal",
      "javascript:alert(1)",
      "/\\evil.com",
      "/\t/evil.com",
      ["/a", "/b"],
    ])("never returns to %j", async (redirect) => {
      configured = false;

      expect((await start(redirect)).url).toBe(
        "https://5stack.gg/?twitch_error=not_configured",
      );
    });

    it("checks the stored redirect again before using it", async () => {
      const state = "s".repeat(43);
      cache.set(
        `twitch:oauth-state:${state}`,
        JSON.stringify({ steam_id: PLAYER, redirect: "/\\evil.com" }),
      );

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://5stack.gg/?twitch=linked",
      );
    });

    it("returns to the panel's own subdomains", async () => {
      const { state } = await start("https://dev.5stack.gg/settings");

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://dev.5stack.gg/settings?twitch=linked",
      );
    });

    it("links the account and throws the user token away", async () => {
      const { state } = await start("/settings/account?tab=links");

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://5stack.gg/settings/account?tab=links&twitch=linked",
      );

      expect(twitch.exchangeCode).toHaveBeenCalledWith(
        CREDENTIALS,
        "code",
        "https://5stack.gg/auth/twitch/callback",
      );
      expect(twitch.revokeToken).toHaveBeenCalledWith(
        CREDENTIALS,
        "user-token",
      );

      const [[deleteSql, deleteArgs], [insertSql, insertArgs]] = linkQueries;
      expect(deleteSql).toContain("DELETE FROM public.player_twitch_accounts");
      expect(deleteArgs).toEqual([PLAYER, "42"]);
      expect(insertSql).toContain("INSERT INTO public.player_twitch_accounts");
      expect(insertArgs).toEqual([PLAYER, "42", "streamer", "Streamer"]);
    });

    it("refuses a Twitch account another player already linked", async () => {
      postgres.transaction.mockRejectedValueOnce(
        Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "player_twitch_accounts_twitch_user_id_key",
        }),
      );
      const { state } = await start("/settings");

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://5stack.gg/settings?twitch_error=already_linked",
      );
    });

    it("reports any other database failure as Twitch being unavailable", async () => {
      postgres.transaction.mockRejectedValueOnce(new Error("connection lost"));
      const { state } = await start("/settings");

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://5stack.gg/settings?twitch_error=twitch_unavailable",
      );
      expect(logger.error).toHaveBeenCalled();
    });

    it("refuses a state it never issued", async () => {
      expect(
        await finish(PLAYER, { state: "x".repeat(43), code: "code" }),
      ).toBe("https://5stack.gg/?twitch_error=invalid_state");
      expect(twitch.exchangeCode).not.toHaveBeenCalled();
    });

    it("refuses a missing or malformed state", async () => {
      for (const state of [undefined, "", "short", ["a", "b"], "../../x"]) {
        expect(await finish(PLAYER, { state, code: "code" })).toBe(
          "https://5stack.gg/?twitch_error=invalid_state",
        );
      }
      expect(redis.multi).not.toHaveBeenCalled();
    });

    // The attack the state exists for: someone sends a callback URL carrying
    // their own Twitch code to another player.
    it("refuses a state another player started", async () => {
      const { state } = await start("/settings");

      expect(await finish(OTHER, { state, code: "code" })).toBe(
        "https://5stack.gg/?twitch_error=invalid_state",
      );
      expect(twitch.exchangeCode).not.toHaveBeenCalled();
    });

    it("refuses a signed-out callback", async () => {
      const { state } = await start("/settings");

      expect(await finish(undefined, { state, code: "code" })).toBe(
        "https://5stack.gg/?twitch_error=invalid_state",
      );
    });

    it("only lets a state be used once", async () => {
      const { state } = await start("/settings");

      await finish(PLAYER, { state, code: "code" });

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://5stack.gg/?twitch_error=invalid_state",
      );
      expect(twitch.exchangeCode).toHaveBeenCalledTimes(1);
    });

    it("reports a player who said no on Twitch", async () => {
      const { state } = await start("/settings");

      expect(
        await finish(PLAYER, {
          state,
          error: "access_denied",
          error_description: "The user denied you access",
        }),
      ).toBe("https://5stack.gg/settings?twitch_error=denied");
      expect(twitch.exchangeCode).not.toHaveBeenCalled();
    });

    it("reports Twitch failing without linking anything", async () => {
      twitch.authenticatedUser.mockRejectedValueOnce(new Error("503"));
      const { state } = await start("/settings");

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://5stack.gg/settings?twitch_error=twitch_unavailable",
      );
      expect(twitch.revokeToken).toHaveBeenCalledWith(
        CREDENTIALS,
        "user-token",
      );
      expect(postgres.transaction).not.toHaveBeenCalled();
    });

    it("refuses when Twitch was unconfigured mid-link", async () => {
      const { state } = await start("/settings");
      configured = false;

      expect(await finish(PLAYER, { state, code: "code" })).toBe(
        "https://5stack.gg/settings?twitch_error=not_configured",
      );
    });
  });

  describe("reads", () => {
    it("hide everything until Twitch is configured", async () => {
      configured = false;

      expect(await service.liveSteamIds()).toEqual([]);
      expect(await service.player(PLAYER)).toBeNull();
      expect(await service.matchStreams(MATCH)).toEqual([]);
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it.each(["1 OR 1=1", "99999999999999999999", "9223372036854775808"])(
      "reject %j without asking the database",
      async (steamId) => {
        expect(await service.player(steamId)).toBeNull();
        expect(postgres.query).not.toHaveBeenCalled();
      },
    );

    it("reject a match id that is not a uuid", async () => {
      expect(await service.matchStreams("not-a-uuid")).toEqual([]);
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("accept the largest steam id that fits", async () => {
      await service.player("9223372036854775807");

      expect(postgres.query.mock.calls[0][1][0]).toBe("9223372036854775807");
    });

    it.each(["abc", "", "99999999999999999999", "9223372036854775808"])(
      "show a malformed viewer %j nothing, never what a guest sees",
      async (viewer) => {
        expect(await service.liveSteamIds(viewer)).toEqual([]);
        expect(await service.player(PLAYER, viewer)).toBeNull();
        expect(await service.matchStreams(MATCH, viewer)).toEqual([]);
        expect(postgres.query).not.toHaveBeenCalled();
      },
    );

    it("filter by the signed-in viewer", async () => {
      await service.liveSteamIds(OTHER);
      await service.player(PLAYER, OTHER);
      await service.matchStreams(MATCH, OTHER);

      expect(postgres.query.mock.calls.map(([, params]) => params)).toEqual([
        [OTHER, false],
        [PLAYER, OTHER, false],
        [MATCH, OTHER, false],
      ]);
      expect(streamAccess.requireLoginForLiveStreams).not.toHaveBeenCalled();
    });

    it("show guests no match POVs while streams require a login", async () => {
      expect(await service.matchStreams(MATCH)).toEqual([]);
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("hide everyone in a Live match from guests while streams require a login", async () => {
      await service.liveSteamIds();
      await service.player(PLAYER);

      expect(postgres.query.mock.calls.map(([, params]) => params)).toEqual([
        [null, true],
        [PLAYER, null, true],
      ]);
    });

    it("show guests everything once streams no longer require a login", async () => {
      loginRequired = false;

      await service.liveSteamIds();
      await service.player(PLAYER);
      await service.matchStreams(MATCH);

      expect(postgres.query.mock.calls.map(([, params]) => params)).toEqual([
        [null, false],
        [PLAYER, null, false],
        [MATCH, null, false],
      ]);
    });

    it("resolve an uploaded avatar the way the other player reads do", async () => {
      postgres.query.mockResolvedValueOnce([
        { steam_id: PLAYER, avatar_url: "avatars/76561198000000001.png" },
        {
          steam_id: OTHER,
          avatar_url: "https://avatars.steamstatic.com/x.jpg",
        },
        { steam_id: "3", avatar_url: null },
      ]);

      expect(
        (await service.matchStreams(MATCH, OTHER)).map(
          ({ avatar_url }) => avatar_url,
        ),
      ).toEqual([
        "https://api.5stack.gg/avatars/76561198000000001.png",
        "https://avatars.steamstatic.com/x.jpg",
        null,
      ]);
      expect(postgres.query.mock.calls[0][0]).toContain(
        "COALESCE(NULLIF(btrim(p.custom_avatar_url), ''), p.avatar_url)",
      );
    });
  });
});
