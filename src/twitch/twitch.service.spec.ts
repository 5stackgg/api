import { TwitchService } from "./twitch.service";

describe("TwitchService", () => {
  const CREDENTIALS = { clientId: "client-id", clientSecret: "client-secret" };

  let settings: Record<string, string>;
  let cache: Map<string, string>;
  let ttls: Map<string, number>;
  let fetchMock: jest.SpyInstance;
  let service: TwitchService;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const postgres = {
    query: jest.fn(async (_sql: string, [names]: [Array<string>]) =>
      names
        .filter((name) => name in settings)
        .map((name) => ({ name, value: settings[name] })),
    ),
  };

  const redis = {
    get: jest.fn(async (key: string) => cache.get(key) ?? null),
    set: jest.fn(
      async (key: string, value: string, _mode: string, seconds: number) => {
        cache.set(key, value);
        ttls.set(key, seconds);
        return "OK";
      },
    ),
    del: jest.fn(async (key: string) => (cache.delete(key) ? 1 : 0)),
  };

  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const appToken = (access_token: string, expires_in = 5_000_000) =>
    json({ access_token, expires_in, token_type: "bearer" });

  const tokenRequests = () =>
    fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/oauth2/token"),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    settings = {
      twitch_client_id: "client-id",
      twitch_client_secret: "client-secret",
    };
    cache = new Map();
    ttls = new Map();
    fetchMock = jest.spyOn(global, "fetch");
    service = new TwitchService(
      logger as any,
      postgres as any,
      { getConnection: () => redis } as any,
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe("credentials", () => {
    it("reads both keys from settings", async () => {
      expect(await service.credentials()).toEqual(CREDENTIALS);
    });

    it.each([
      ["the client id is missing", { twitch_client_secret: "secret" }],
      ["the secret is missing", { twitch_client_id: "id" }],
      [
        "a key is only whitespace",
        { twitch_client_id: "id", twitch_client_secret: "  " },
      ],
    ])("is off when %s", async (_case, values) => {
      settings = values;

      expect(await service.credentials()).toBeNull();
    });
  });

  describe("app token", () => {
    it("is cached until shortly before Twitch says it expires", async () => {
      fetchMock.mockResolvedValueOnce(appToken("app-1", 3600));

      expect(await service.appToken(CREDENTIALS)).toBe("app-1");
      expect(await service.appToken(CREDENTIALS)).toBe("app-1");

      expect(tokenRequests()).toHaveLength(1);
      expect([...ttls.values()]).toEqual([3600 - 300]);

      const [, init] = tokenRequests()[0];
      expect(new URLSearchParams(init.body).get("grant_type")).toBe(
        "client_credentials",
      );
    });

    it("is requested once for callers that ask at the same time", async () => {
      let answer: (value: unknown) => void;
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );

      const first = service.appToken(CREDENTIALS);
      const second = service.appToken(CREDENTIALS);
      await new Promise((resolve) => setImmediate(resolve));
      answer(appToken("app-1"));

      expect(await Promise.all([first, second])).toEqual(["app-1", "app-1"]);
      expect(tokenRequests()).toHaveLength(1);
    });

    it("is not shared with a different app", async () => {
      fetchMock
        .mockResolvedValueOnce(appToken("app-1"))
        .mockResolvedValueOnce(appToken("app-2"));

      expect(await service.appToken(CREDENTIALS)).toBe("app-1");
      expect(
        await service.appToken({ ...CREDENTIALS, clientSecret: "rotated" }),
      ).toBe("app-2");
    });

    it("is never cached for less than a minute", async () => {
      fetchMock.mockResolvedValueOnce(appToken("app-1", 30));

      await service.appToken(CREDENTIALS);

      expect([...ttls.values()]).toEqual([60]);
    });
  });

  describe("liveStreams", () => {
    const ids = Array.from({ length: 100 }, (_, index) => String(index + 1));

    it("asks for up to a hundred users' live streams in one call", async () => {
      fetchMock
        .mockResolvedValueOnce(appToken("app-1"))
        .mockResolvedValueOnce(json({ data: [{ user_id: "7" }] }));

      expect(await service.liveStreams(CREDENTIALS, ids)).toEqual([
        { user_id: "7" },
      ]);

      const [url, init] = fetchMock.mock.calls[1];
      const query = new URL(String(url));
      expect(query.pathname).toBe("/helix/streams");
      expect(query.searchParams.getAll("user_id")).toEqual(ids);
      expect(query.searchParams.get("type")).toBe("live");
      expect(query.searchParams.get("first")).toBe("100");
      expect(init.headers).toEqual({
        Authorization: "Bearer app-1",
        "Client-Id": "client-id",
      });
    });

    it("refuses more than a hundred users", async () => {
      await expect(
        service.liveStreams(CREDENTIALS, [...ids, "101"]),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not call Twitch for nobody", async () => {
      expect(await service.liveStreams(CREDENTIALS, [])).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gets a new token once when Twitch rejects the cached one", async () => {
      fetchMock
        .mockResolvedValueOnce(appToken("stale"))
        .mockResolvedValueOnce(json({}, 401))
        .mockResolvedValueOnce(appToken("fresh"))
        .mockResolvedValueOnce(json({ data: [] }));

      expect(await service.liveStreams(CREDENTIALS, ["1"])).toEqual([]);

      expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe(
        "Bearer fresh",
      );
      expect([...cache.values()]).toEqual(["fresh"]);
    });

    it("fails rather than reporting nobody live when Twitch errors", async () => {
      fetchMock
        .mockResolvedValueOnce(appToken("app-1"))
        .mockResolvedValueOnce(json({}, 503));

      await expect(service.liveStreams(CREDENTIALS, ["1"])).rejects.toThrow(
        "503",
      );
    });
  });

  describe("isCounterStrike", () => {
    it.each([
      [{ game_id: "32399", game_name: "Counter-Strike" }, true],
      [{ game_id: "32399", game_name: "" }, true],
      [{ game_id: "", game_name: "Counter-Strike" }, true],
      [{ game_id: "509658", game_name: "Just Chatting" }, false],
      [{ game_id: "", game_name: "" }, false],
    ])("%j -> %s", (stream, expected) => {
      expect(TwitchService.isCounterStrike(stream)).toBe(expected);
    });
  });

  describe("linking", () => {
    it("asks for no scopes", () => {
      const url = new URL(
        service.authorizeUrl(
          CREDENTIALS,
          "https://5stack.gg/auth/twitch/callback",
          "state",
        ),
      );

      expect(url.origin + url.pathname).toBe(
        "https://id.twitch.tv/oauth2/authorize",
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: "code",
        client_id: "client-id",
        redirect_uri: "https://5stack.gg/auth/twitch/callback",
        scope: "",
        state: "state",
      });
    });

    it("exchanges the code with the same redirect url", async () => {
      fetchMock.mockResolvedValueOnce(json({ access_token: "user-token" }));

      expect(
        await service.exchangeCode(
          CREDENTIALS,
          "code",
          "https://5stack.gg/auth/twitch/callback",
        ),
      ).toBe("user-token");

      const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(Object.fromEntries(form)).toEqual({
        client_id: "client-id",
        client_secret: "client-secret",
        code: "code",
        grant_type: "authorization_code",
        redirect_uri: "https://5stack.gg/auth/twitch/callback",
      });
    });

    it("reads who the user token belongs to", async () => {
      fetchMock.mockResolvedValueOnce(
        json({ data: [{ id: "42", login: "streamer", display_name: "Str" }] }),
      );

      expect(
        await service.authenticatedUser(CREDENTIALS, "user-token"),
      ).toEqual({ id: "42", login: "streamer", display_name: "Str" });
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        "Bearer user-token",
      );
    });

    it("never throws while revoking a user token", async () => {
      fetchMock.mockRejectedValueOnce(new Error("offline"));

      await expect(
        service.revokeToken(CREDENTIALS, "user-token"),
      ).resolves.toBeUndefined();
    });
  });
});
