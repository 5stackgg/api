import { PostgresService } from "./../src/postgres/postgres.service";
import { SteamMatchHistoryService } from "../src/steam-match-history/steam-match-history.service";
import { ResolveMatchMetadata } from "../src/steam-match-history/jobs/ResolveMatchMetadata";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const SHARE_CODE = "CSGO-fhdrj-2EkxQ-8Tqrn-bmDBE-3VeuA";
const VALVE_MATCH_ID = "3299746880671809554";

describe("import a Valve match from a pasted share code", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ImportShareCodeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199410000000n);
    await seedRegionWithServer(postgres, "TestImportShareCode");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM pending_match_imports");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      `INSERT INTO settings (name, value)
       VALUES ('public.external_matches_enabled', 'true')
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
    );
  });

  const build = () => {
    const cache = new Map<string, unknown>();
    const resolveQueue = {
      remove: jest.fn(async (): Promise<void> => undefined),
      add: jest.fn(async (): Promise<void> => undefined),
    };
    const service = new SteamMatchHistoryService(
      { get: () => "steam-api-key" } as never,
      {} as never,
      postgres,
      {
        has: async (key: string) => cache.has(key),
        put: async (key: string, value: unknown) => {
          cache.set(key, value);
        },
        acquireLock: async (key: string) => {
          if (cache.has(key)) {
            return false;
          }
          cache.set(key, true);
          return true;
        },
      } as never,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      resolveQueue as never,
      { isAvailable: () => true } as never,
      { add: jest.fn(async (): Promise<void> => undefined) } as never,
    );
    return { service, resolveQueue };
  };

  const pending = async () => {
    const rows = await postgres.query<
      Array<{ share_code: string; status: string; error: string | null }>
    >(
      `SELECT share_code, status, error FROM pending_match_imports
        WHERE valve_match_id = $1::numeric`,
      [VALVE_MATCH_ID],
    );
    return rows.at(0) ?? null;
  };

  const requesters = async () => {
    const rows = await postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text FROM pending_match_import_players
        WHERE valve_match_id = $1::numeric ORDER BY steam_id`,
      [VALVE_MATCH_ID],
    );
    return rows.map((row) => row.steam_id);
  };

  const seedPending = async (
    status: string,
    requester: string,
    shareCode = SHARE_CODE,
  ) => {
    await postgres.query(
      `INSERT INTO pending_match_imports (valve_match_id, share_code, status, error)
       VALUES ($1::numeric, $2, $3, CASE WHEN $3 = 'Failed' THEN 'gc timed out' END)`,
      [VALVE_MATCH_ID, shareCode, status],
    );
    await postgres.query(
      `INSERT INTO pending_match_import_players (valve_match_id, steam_id)
       VALUES ($1::numeric, $2::bigint)`,
      [VALVE_MATCH_ID, requester],
    );
  };

  it("queues a pasted CS2 share link under the player who pasted it", async () => {
    const player = await fx.player();
    const { service, resolveQueue } = build();

    await expect(
      service.importShareCode(
        player,
        `steam://rungame/730/76561202255233023/+csgo_download_match%20${SHARE_CODE}`,
      ),
    ).resolves.toEqual({ ok: true });

    await expect(pending()).resolves.toEqual({
      share_code: SHARE_CODE,
      status: "Queued",
      error: null,
    });
    await expect(requesters()).resolves.toEqual([player]);
    expect(resolveQueue.add).toHaveBeenCalledTimes(1);
  });

  it("refuses a Valve match that is already imported", async () => {
    const player = await fx.player();
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      `UPDATE matches SET source = 'valve', external_id = $2 WHERE id = $1`,
      [matchId, VALVE_MATCH_ID],
    );
    const { service, resolveQueue } = build();

    await expect(service.importShareCode(player, SHARE_CODE)).resolves.toEqual({
      ok: false,
      error: "match already imported",
    });
    await expect(pending()).resolves.toBeNull();
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("re-queues a failed import and adds the new requester", async () => {
    const [first, second] = await fx.players(2);
    await seedPending("Failed", first);
    const { service, resolveQueue } = build();

    await expect(service.importShareCode(second, SHARE_CODE)).resolves.toEqual({
      ok: true,
    });

    await expect(pending()).resolves.toEqual({
      share_code: SHARE_CODE,
      status: "Queued",
      error: null,
    });
    await expect(requesters()).resolves.toEqual([first, second].sort());
    expect(resolveQueue.add).toHaveBeenCalledTimes(1);
  });

  it("retries a failed import with the code just pasted, not the one that failed", async () => {
    const [first, second] = await fx.players(2);
    await seedPending("Failed", first, "CSGO-ehdrj-2EkxQ-8Tqrn-bmDBE-3VeuA");
    const { service } = build();

    await expect(service.importShareCode(second, SHARE_CODE)).resolves.toEqual({
      ok: true,
    });

    await expect(pending()).resolves.toMatchObject({
      share_code: SHARE_CODE,
      status: "Queued",
    });
  });

  it("refuses a match that came in another way but already carries this share code", async () => {
    const player = await fx.player();
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      `UPDATE matches
          SET source = 'valve', external_id = 'uploaded-demo', share_code = $2
        WHERE id = $1`,
      [matchId, SHARE_CODE],
    );
    const { service, resolveQueue } = build();

    await expect(service.importShareCode(player, SHARE_CODE)).resolves.toEqual({
      ok: false,
      error: "match already imported",
    });
    await expect(pending()).resolves.toBeNull();
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("leaves an import in flight alone but records the requester", async () => {
    const [first, second] = await fx.players(2);
    await seedPending("Parsing", first);
    const { service, resolveQueue } = build();

    await expect(service.importShareCode(second, SHARE_CODE)).resolves.toEqual({
      ok: true,
    });

    await expect(pending()).resolves.toMatchObject({ status: "Parsing" });
    await expect(requesters()).resolves.toEqual([first, second].sort());
    expect(resolveQueue.add).not.toHaveBeenCalled();
  });

  it("throttles a second paste from the same player", async () => {
    const player = await fx.player();
    const { service } = build();

    await expect(service.importShareCode(player, SHARE_CODE)).resolves.toEqual({
      ok: true,
    });
    await expect(
      service.importShareCode(player, SHARE_CODE),
    ).resolves.toMatchObject({ ok: false });
  });

  // The extension sends a page's worth of codes at once and has its own
  // hourly cap, so the per-paste throttle would refuse all but the first.
  it("skips the per-paste throttle for a batch from the extension", async () => {
    const player = await fx.player();
    const { service } = build();

    await expect(service.importShareCode(player, SHARE_CODE)).resolves.toEqual({
      ok: true,
    });
    await expect(
      service.importShareCode(player, SHARE_CODE, { cooldown: false }),
    ).resolves.toEqual({ ok: true });
  });

  it("looks up where each share code's import stands", async () => {
    const player = await fx.player();
    const { service } = build();
    const OTHER = "CSGO-bB99d-EEBtm-RzCYc-GjD8g-ofYCA";

    await expect(
      service.lookupShareCodes([SHARE_CODE, OTHER, "not a code"]),
    ).resolves.toEqual({
      [SHARE_CODE]: { state: "none" },
      [OTHER]: { state: "none" },
      "not a code": { state: "none", reason: "invalid share code" },
    });

    await seedPending("Failed", player);
    await expect(service.lookupShareCodes([SHARE_CODE])).resolves.toEqual({
      [SHARE_CODE]: { state: "failed", reason: "gc timed out" },
    });

    const ctx = await fx.bareMatch();
    await postgres.query(
      `UPDATE matches SET source = 'valve', external_id = $2 WHERE id = $1`,
      [ctx.matchId, VALVE_MATCH_ID],
    );
    await expect(service.lookupShareCodes([SHARE_CODE])).resolves.toEqual({
      [SHARE_CODE]: { state: "imported", match_id: ctx.matchId },
    });
  });
});

describe("a share code import is only for someone who played", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ImportShareCodePlayersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199430000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM pending_match_imports");
    await postgres.query("DELETE FROM players");
  });

  const accountId = (steamId: string) =>
    Number(BigInt(steamId) - 76561197960265728n);

  const resolveWith = async (requester: string, accountIds: Array<number>) => {
    await postgres.query(
      `INSERT INTO pending_match_imports (valve_match_id, share_code, status)
       VALUES ($1::numeric, $2, 'Queued')`,
      [VALVE_MATCH_ID, SHARE_CODE],
    );
    await postgres.query(
      `INSERT INTO pending_match_import_players (valve_match_id, steam_id)
       VALUES ($1::numeric, $2::bigint)`,
      [VALVE_MATCH_ID, requester],
    );
    const parseQueue = {
      remove: jest.fn(async (): Promise<void> => undefined),
      add: jest.fn(async (): Promise<void> => undefined),
    };
    const job = new ResolveMatchMetadata(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      {
        isAvailable: () => true,
        resolveShareCode: async () => ({
          demoUrl: "http://replay123.valve.net/730/match.dem.bz2",
          mapName: "de_dust2",
          matchStartTime: "2026-10-13T20:02:53.000Z",
          accountIds,
        }),
      } as never,
      {} as never,
      parseQueue as never,
    );
    await job.process({
      data: { valve_match_id: VALVE_MATCH_ID },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as never);
    const [row] = await postgres.query<
      Array<{ status: string; error: string | null; demo_url: string | null }>
    >(
      `SELECT status, error, demo_url FROM pending_match_imports
        WHERE valve_match_id = $1::numeric`,
      [VALVE_MATCH_ID],
    );
    return { row, parseQueue };
  };

  it("imports a match the requester played in", async () => {
    const player = await fx.player();

    const { row, parseQueue } = await resolveWith(player, [
      accountId(player),
      12345,
    ]);

    expect(row.status).toBe("Queued");
    expect(parseQueue.add).toHaveBeenCalled();
  });

  it("refuses a match the requester was not in, before keeping its demo", async () => {
    const player = await fx.player();

    const { row, parseQueue } = await resolveWith(player, [12345, 67890]);

    expect(row).toMatchObject({
      status: "Failed",
      error: "only players in this match can import it",
      demo_url: null,
    });
    expect(parseQueue.add).not.toHaveBeenCalled();
  });

  it("lets a match organizer import a match they were not in", async () => {
    const organizer = await fx.player("organizer", "match_organizer");

    const { parseQueue } = await resolveWith(organizer, [12345]);

    expect(parseQueue.add).toHaveBeenCalled();
  });

  it("does not let a moderator import a match they were not in", async () => {
    const moderator = await fx.player("moderator", "moderator");

    const { row } = await resolveWith(moderator, [12345]);

    expect(row.status).toBe("Failed");
  });

  it("refuses an import when Valve names no players", async () => {
    const player = await fx.player();

    const { row, parseQueue } = await resolveWith(player, []);

    expect(row.status).toBe("Failed");
    expect(parseQueue.add).not.toHaveBeenCalled();
  });

  it("still lets an administrator import when Valve names no players", async () => {
    const admin = await fx.player("admin", "administrator");

    const { parseQueue } = await resolveWith(admin, []);

    expect(parseQueue.add).toHaveBeenCalled();
  });
});
