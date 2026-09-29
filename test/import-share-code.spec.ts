import { PostgresService } from "./../src/postgres/postgres.service";
import { SteamMatchHistoryService } from "../src/steam-match-history/steam-match-history.service";
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
});
