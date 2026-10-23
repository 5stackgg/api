import { PollSteamMatchHistoryForUser } from "./jobs/PollSteamMatchHistoryForUser";
import { SteamMatchHistoryService } from "./steam-match-history.service";

const SHARE_CODE = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";
const VALVE_MATCH_ID = "3230642215713767580";
const STEAM_ID = "76561197960500905";

type QueryCall = { sql: string; params: unknown[] };

const build = (
  options: {
    importsEnabled?: boolean;
    gcAvailable?: boolean;
    alreadyImported?: boolean;
    pendingStatus?: "Queued" | "Parsing" | "Failed" | null;
    onCooldown?: boolean;
  } = {},
) => {
  const {
    importsEnabled = true,
    gcAvailable = true,
    alreadyImported = false,
    pendingStatus = null,
    onCooldown = false,
  } = options;

  const calls: QueryCall[] = [];
  const postgres = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("public.external_matches_enabled")) {
        return [{ value: importsEnabled ? "true" : "false" }];
      }
      if (sql.includes("FROM public.matches")) {
        return alreadyImported ? [{ id: "match-1" }] : [];
      }
      if (sql.includes("INSERT INTO public.pending_match_imports ")) {
        return [{ inserted: pendingStatus === null }];
      }
      if (sql.includes("SET status = 'Queued'")) {
        return pendingStatus === "Failed"
          ? [{ valve_match_id: VALVE_MATCH_ID }]
          : [];
      }
      return [];
    }),
  };
  let now = 0;
  const expiresAt = new Map<string, number>();
  const live = (key: string) => (expiresAt.get(key) ?? -1) > now;
  const hold = (key: string, seconds?: number) => {
    expiresAt.set(key, seconds ? now + seconds * 1000 : Infinity);
  };
  const cache = {
    has: jest.fn(async (key: string) => onCooldown || live(key)),
    put: jest.fn(
      async (key: string, _value: unknown, seconds?: number): Promise<void> => {
        hold(key, seconds);
      },
    ),
    acquireLock: jest.fn(async (key: string, seconds: number) => {
      if (onCooldown || live(key)) {
        return false;
      }
      hold(key, seconds);
      return true;
    }),
  };
  const advance = (seconds: number) => {
    now += seconds * 1000;
  };
  const resolveQueue = {
    remove: jest.fn(async (): Promise<void> => undefined),
    add: jest.fn(async (): Promise<void> => undefined),
  };
  const pollQueue = {
    add: jest.fn(async (): Promise<void> => undefined),
    remove: jest.fn(async (): Promise<number> => 1),
  };
  const hasura = {
    query: jest.fn(async () => ({
      player_steam_match_auth_by_pk: {
        auth_code: "AAAA-AAAAA-AAAA",
        last_known_share_code: "CSGO-known",
      },
    })),
    mutation: jest.fn(async () => ({})),
  };
  const steamGc = { isAvailable: jest.fn(() => gcAvailable) };
  const config = { get: jest.fn(() => "steam-api-key") };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new SteamMatchHistoryService(
    config as never,
    hasura as never,
    postgres as never,
    cache as never,
    logger as never,
    resolveQueue as never,
    steamGc as never,
    pollQueue as never,
  );

  return { service, calls, cache, resolveQueue, pollQueue, advance };
};

const steamReply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }) as Response;

const NOTHING_NEW = steamReply(200, { result: { nextcode: "n/a" } });

describe("SteamMatchHistoryService polling after a match ends", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(NOTHING_NEW);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("asks Steam for the finished match even though a poll ran minutes earlier", async () => {
    const { service } = build();
    const job = new PollSteamMatchHistoryForUser(service);
    await service.pollForUser(STEAM_ID);
    fetchMock.mockClear();

    await job.process({
      data: { steamId: STEAM_ID, matchEnd: true },
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still skips an ordinary poll inside the cooldown", async () => {
    const { service } = build();
    await service.pollForUser(STEAM_ID);
    fetchMock.mockClear();

    await expect(service.pollForUser(STEAM_ID)).resolves.toMatchObject({
      error: "within poll cooldown",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not ask Steam again after a 429, even for a finished match", async () => {
    const { service } = build();
    fetchMock.mockResolvedValueOnce(steamReply(429));
    await service.pollForUser(STEAM_ID);
    fetchMock.mockClear();

    await expect(
      service.pollForUser(STEAM_ID, { matchEnd: true }),
    ).resolves.toMatchObject({ error: "steam web api rate limited" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps ordinary polls off Steam for the hour after a 429, past the 10-minute cooldown", async () => {
    const { service, advance } = build();
    fetchMock.mockResolvedValueOnce(steamReply(429));
    await service.pollForUser(STEAM_ID);
    fetchMock.mockClear();

    advance(11 * 60);
    await expect(service.pollForUser(STEAM_ID)).resolves.toMatchObject({
      error: "steam web api rate limited",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    advance(50 * 60);
    await service.pollForUser(STEAM_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries once more a few minutes later when Valve has not published the match yet", async () => {
    const { service, pollQueue } = build();

    await service.pollAfterMatchEnd(STEAM_ID, false);

    expect(pollQueue.add).toHaveBeenCalledTimes(1);
    expect(pollQueue.add).toHaveBeenCalledWith(
      "PollSteamMatchHistoryForUser",
      { steamId: STEAM_ID, matchEnd: true, retry: true },
      expect.objectContaining({ delay: 4 * 60 * 1000 }),
    );
  });

  it("stops after that one retry", async () => {
    const { service, pollQueue } = build();

    await service.pollAfterMatchEnd(STEAM_ID, true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pollQueue.add).not.toHaveBeenCalled();
    expect(pollQueue.remove).not.toHaveBeenCalled();
  });

  it("drops a retry still waiting from an earlier match end", async () => {
    const { service, pollQueue } = build();

    await service.pollAfterMatchEnd(STEAM_ID, false);

    const retryJobId = `poll-steam-match-history.match-end-retry.${STEAM_ID}`;
    expect(pollQueue.remove).toHaveBeenCalledWith(retryJobId);
    expect(pollQueue.remove.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
    expect(pollQueue.add).toHaveBeenCalledWith(
      "PollSteamMatchHistoryForUser",
      expect.anything(),
      expect.objectContaining({ jobId: retryJobId }),
    );
  });

  it("does not retry once the finished match is found", async () => {
    const { service, pollQueue, resolveQueue } = build();
    fetchMock.mockResolvedValueOnce(
      steamReply(200, { result: { nextcode: SHARE_CODE } }),
    );

    await service.pollAfterMatchEnd(STEAM_ID, false);

    expect(resolveQueue.add).toHaveBeenCalledWith(
      "ResolveMatchMetadata",
      { valve_match_id: VALVE_MATCH_ID },
      expect.anything(),
    );
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it("does not retry when Steam rate limited the first try", async () => {
    const { service, pollQueue } = build();
    fetchMock.mockResolvedValueOnce(steamReply(429));

    await service.pollAfterMatchEnd(STEAM_ID, false);

    expect(pollQueue.add).not.toHaveBeenCalled();
  });
});

describe("SteamMatchHistoryService.importShareCode", () => {
  it("queues a new share code for resolve under the requesting player", async () => {
    const { service, calls, resolveQueue } = build();

    await expect(
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ).resolves.toEqual({ ok: true });

    const pending = calls.find((call) =>
      call.sql.includes("INSERT INTO public.pending_match_imports "),
    );
    expect(pending?.params).toEqual([VALVE_MATCH_ID, SHARE_CODE]);
    const requester = calls.find((call) =>
      call.sql.includes("INSERT INTO public.pending_match_import_players"),
    );
    expect(requester?.params).toEqual([VALVE_MATCH_ID, STEAM_ID]);
    expect(resolveQueue.add).toHaveBeenCalledTimes(1);
    expect(resolveQueue.add).toHaveBeenCalledWith(
      "ResolveMatchMetadata",
      { valve_match_id: VALVE_MATCH_ID },
      expect.objectContaining({ jobId: `resolve-${VALVE_MATCH_ID}` }),
    );
  });

  it("pulls the code out of a CS2 share link", async () => {
    const { service, calls } = build();

    await service.importShareCode(
      STEAM_ID,
      `steam://rungame/730/76561202255233023/+csgo_download_match%20${SHARE_CODE}`,
    );

    const pending = calls.find((call) =>
      call.sql.includes("INSERT INTO public.pending_match_imports "),
    );
    expect(pending?.params).toEqual([VALVE_MATCH_ID, SHARE_CODE]);
  });

  it("stores the canonical CSGO- prefix whatever case was pasted", async () => {
    const { service, calls } = build();

    await service.importShareCode(STEAM_ID, SHARE_CODE.replace("CSGO", "csgo"));

    const pending = calls.find((call) =>
      call.sql.includes("INSERT INTO public.pending_match_imports "),
    );
    expect(pending?.params).toEqual([VALVE_MATCH_ID, SHARE_CODE]);
  });

  it("rejects text that is not a share code", async () => {
    const { service, resolveQueue, cache } = build();

    await expect(
      service.importShareCode(STEAM_ID, "CSGO-00000-00000-00000-00000-00000"),
    ).resolves.toEqual({ ok: false, error: "invalid share code" });
    await expect(service.importShareCode(STEAM_ID, "nope")).resolves.toEqual({
      ok: false,
      error: "invalid share code",
    });
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.acquireLock).not.toHaveBeenCalled();
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("rejects a code with extra characters on its last group", async () => {
    const { service, resolveQueue } = build();

    await expect(
      service.importShareCode(STEAM_ID, `${SHARE_CODE}X`),
    ).resolves.toEqual({ ok: false, error: "invalid share code" });
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("refuses when the operator has external imports switched off", async () => {
    const { service, resolveQueue } = build({ importsEnabled: false });

    await expect(
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ).resolves.toEqual({
      ok: false,
      error: "external match imports are disabled",
    });
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("refuses when no GC account is configured to resolve the code", async () => {
    const { service, resolveQueue } = build({ gcAvailable: false });

    await expect(
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ).resolves.toEqual({ ok: false, error: "steam gc not configured" });
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("throttles back-to-back imports from one player", async () => {
    const { service, resolveQueue } = build({ onCooldown: true });

    const result = await service.importShareCode(STEAM_ID, SHARE_CODE);

    expect(result.ok).toBe(false);
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("lets only one of two simultaneous pastes from a player through", async () => {
    const { service, resolveQueue } = build();

    const results = await Promise.all([
      service.importShareCode(STEAM_ID, SHARE_CODE),
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(resolveQueue.add).toHaveBeenCalledTimes(1);
  });

  it("reports a match that is already imported instead of queueing it", async () => {
    const { service, calls, resolveQueue } = build({ alreadyImported: true });

    await expect(
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ).resolves.toEqual({ ok: false, error: "match already imported" });
    const lookup = calls.find((call) =>
      call.sql.includes("FROM public.matches"),
    );
    expect(lookup?.params).toEqual([VALVE_MATCH_ID, SHARE_CODE]);
    expect(
      calls.some((call) => call.sql.includes("pending_match_import")),
    ).toBe(false);
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("re-queues a pending import that previously failed", async () => {
    const { service, resolveQueue } = build({ pendingStatus: "Failed" });

    await expect(
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ).resolves.toEqual({ ok: true });
    expect(resolveQueue.add).toHaveBeenCalledTimes(1);
  });

  it("leaves an import that is already in flight alone", async () => {
    const { service, calls, resolveQueue } = build({
      pendingStatus: "Parsing",
    });

    await expect(
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ).resolves.toEqual({ ok: true });
    const requester = calls.find((call) =>
      call.sql.includes("INSERT INTO public.pending_match_import_players"),
    );
    expect(requester?.params).toEqual([VALVE_MATCH_ID, STEAM_ID]);
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });
});
