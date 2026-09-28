import { SteamMatchHistoryService } from "./steam-match-history.service";

const SHARE_CODE = "CSGO-fhdrj-2EkxQ-8Tqrn-bmDBE-3VeuA";
const VALVE_MATCH_ID = "3299746880671809554";
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
  const cache = {
    has: jest.fn(async () => onCooldown),
    put: jest.fn(async (): Promise<void> => undefined),
  };
  const resolveQueue = {
    remove: jest.fn(async (): Promise<void> => undefined),
    add: jest.fn(async (): Promise<void> => undefined),
  };
  const steamGc = { isAvailable: jest.fn(() => gcAvailable) };
  const config = { get: jest.fn(() => "steam-api-key") };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new SteamMatchHistoryService(
    config as never,
    {} as never,
    postgres as never,
    cache as never,
    logger as never,
    resolveQueue as never,
    steamGc as never,
  );

  return { service, calls, cache, resolveQueue };
};

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

  it("reports a match that is already imported instead of queueing it", async () => {
    const { service, calls, resolveQueue } = build({ alreadyImported: true });

    await expect(
      service.importShareCode(STEAM_ID, SHARE_CODE),
    ).resolves.toEqual({ ok: false, error: "match already imported" });
    const lookup = calls.find((call) =>
      call.sql.includes("FROM public.matches"),
    );
    expect(lookup?.params).toEqual([VALVE_MATCH_ID]);
    expect(
      calls.some((call) => call.sql.includes("pending_match_imports ")),
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
