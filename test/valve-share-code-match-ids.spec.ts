import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { SteamMatchHistoryService } from "../src/steam-match-history/steam-match-history.service";
import { ParseImportedDemo } from "../src/steam-match-history/jobs/ParseImportedDemo";
import { ResolveMatchMetadata } from "../src/steam-match-history/jobs/ResolveMatchMetadata";
import { ReconcilePendingMatchImports } from "../src/steam-match-history/jobs/ReconcilePendingMatchImports";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const SHARE_CODE = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";
const VALVE_MATCH_ID = "3230642215713767580";
const OLD_ID = "10336746529758569196";

const SAME_MATCH_SHARE_CODE = "CSGO-oR5b2-uAOEH-p8MAs-smZRo-TO2xK";
const SAME_MATCH_OLD_ID = "10408804123796497132";

const NOT_VALVE_SHARE_CODE = "CSGO-GADqg-jjyJ8-cSP2r-smZRo-TO2xK";

const CODES = [
  { shareCode: SHARE_CODE, valveMatchId: VALVE_MATCH_ID, oldId: OLD_ID },
  {
    shareCode: "CSGO-vGqmL-vb2x2-nTQtU-e9dco-qWHzN",
    valveMatchId: "3354591898827227340",
    oldId: "4421858149950929973",
  },
  {
    shareCode: "CSGO-dDTOM-tT9ur-wEavE-uqERi-LCSGO",
    valveMatchId: "3354591961205914320",
    oldId: "17367797286871173692",
  },
];

const DEMO_URL = "http://replay123.valve.net/730/match.dem.bz2";

describe("Valve match ids recomputed from stored share codes", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1890000001360_valve_share_code_match_ids/up.sql",
    ),
    "utf8",
  );

  beforeAll(async () => {
    db = await bootMigratedDb("ValveShareCodeMatchIdsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199440000000n);
    await seedRegionWithServer(postgres, "TestValveShareCodeIds");
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

  const seedPending = async (
    valveMatchId: string,
    shareCode: string,
    requesters: Array<string>,
    status = "Queued",
    demoUrl: string | null = null,
  ) => {
    await postgres.query(
      `INSERT INTO pending_match_imports (valve_match_id, share_code, status, demo_url)
       VALUES ($1::numeric, $2, $3, $4)`,
      [valveMatchId, shareCode, status, demoUrl],
    );
    for (const steamId of requesters) {
      await postgres.query(
        `INSERT INTO pending_match_import_players (valve_match_id, steam_id)
         VALUES ($1::numeric, $2::bigint)`,
        [valveMatchId, steamId],
      );
    }
  };

  const pending = () =>
    postgres.query<
      Array<{ valve_match_id: string; share_code: string; status: string }>
    >(
      `SELECT valve_match_id::text AS valve_match_id, share_code, status
         FROM pending_match_imports
        ORDER BY share_code COLLATE "C"`,
    );

  const requesters = async (valveMatchId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text FROM pending_match_import_players
          WHERE valve_match_id = $1::numeric ORDER BY steam_id`,
        [valveMatchId],
      )
    ).map((row) => row.steam_id);

  const seedMatch = async (
    source: string,
    externalId: string | null,
    shareCode: string | null,
  ) => {
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      `UPDATE matches SET source = $2, external_id = $3, share_code = $4
        WHERE id = $1`,
      [matchId, source, externalId, shareCode],
    );
    return matchId;
  };

  const externalId = async (matchId: string) =>
    (
      await postgres.query<Array<{ external_id: string | null }>>(
        "SELECT external_id FROM matches WHERE id = $1",
        [matchId],
      )
    ).at(0)?.external_id;

  const resolveQueue = () => ({
    remove: jest.fn(async (): Promise<void> => undefined),
    add: jest.fn(async (): Promise<void> => undefined),
    getJob: jest.fn(async (): Promise<undefined> => undefined),
  });

  const service = (queue = resolveQueue()) => {
    const locks = new Set<string>();
    return new SteamMatchHistoryService(
      { get: () => "steam-api-key" } as never,
      {} as never,
      postgres,
      {
        acquireLock: async (key: string) => {
          if (locks.has(key)) {
            return false;
          }
          locks.add(key);
          return true;
        },
      } as never,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      queue as never,
      { isAvailable: () => true } as never,
      { add: jest.fn(async (): Promise<void> => undefined) } as never,
    );
  };

  const parseJob = (importExternalDemo: jest.Mock) =>
    new ParseImportedDemo(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      { parseFromUrl: async () => ({}) } as never,
      {
        findExistingExternalMatch: async (source: string, id: string) =>
          (
            await postgres.query<Array<{ id: string }>>(
              "SELECT id FROM matches WHERE source = $1 AND external_id = $2",
              [source, id],
            )
          ).at(0)?.id ?? null,
        persistShareCode: jest.fn(async (): Promise<void> => undefined),
        importExternalDemo,
      } as never,
    );

  it("re-keys each pending import and its requesters to Valve's match id", async () => {
    const players = await fx.players(2);
    for (const { shareCode, oldId } of CODES) {
      await seedPending(oldId, shareCode, players);
    }

    await postgres.query(up);

    await expect(pending()).resolves.toEqual(
      CODES.map(({ shareCode, valveMatchId }) => ({
        valve_match_id: valveMatchId,
        share_code: shareCode,
        status: "Queued",
      })).sort((a, b) => (a.share_code < b.share_code ? -1 : 1)),
    );
    for (const { valveMatchId } of CODES) {
      await expect(requesters(valveMatchId)).resolves.toEqual(
        [...players].sort(),
      );
    }
  });

  it("gives each imported Valve match Valve's match id, once", async () => {
    const matches = [];
    for (const { shareCode, oldId } of CODES) {
      matches.push(await seedMatch("valve", oldId, shareCode));
    }

    await postgres.query(up);
    await postgres.query(up);

    for (const [i, { valveMatchId }] of CODES.entries()) {
      await expect(externalId(matches[i])).resolves.toBe(valveMatchId);
    }
  });

  it("refuses another share code of a match imported before the fix", async () => {
    const player = await fx.player();
    const matchId = await seedMatch("valve", OLD_ID, SHARE_CODE);

    await postgres.query(up);

    await expect(
      service().importShareCode(player, SAME_MATCH_SHARE_CODE),
    ).resolves.toEqual({ ok: false, error: "match already imported" });
    await expect(
      service().lookupShareCodes([SAME_MATCH_SHARE_CODE]),
    ).resolves.toEqual({
      [SAME_MATCH_SHARE_CODE]: { state: "imported", match_id: matchId },
    });
    await expect(pending()).resolves.toEqual([]);
  });

  it("re-queues a failed import from before the fix instead of adding another", async () => {
    const [first, second] = await fx.players(2);
    await seedPending(OLD_ID, SHARE_CODE, [first], "Failed");

    await postgres.query(up);

    await expect(
      service().importShareCode(second, SHARE_CODE),
    ).resolves.toEqual({ ok: true });
    await expect(pending()).resolves.toEqual([
      {
        valve_match_id: VALVE_MATCH_ID,
        share_code: SHARE_CODE,
        status: "Queued",
      },
    ]);
    await expect(requesters(VALVE_MATCH_ID)).resolves.toEqual(
      [first, second].sort(),
    );
  });

  it("leaves ids the old decoder did not write alone", async () => {
    const player = await fx.player();
    const uploaded = await seedMatch("valve", "uploaded-demo", SHARE_CODE);
    const withoutCode = await seedMatch("valve", OLD_ID, null);
    const faceit = await seedMatch("faceit", OLD_ID, SHARE_CODE);
    const fiveStack = await seedMatch("5stack", OLD_ID, SHARE_CODE);
    await seedPending(
      CODES[1].valveMatchId,
      CODES[1].shareCode,
      [player],
      "Parsing",
    );

    await postgres.query(up);

    await expect(externalId(uploaded)).resolves.toBe("uploaded-demo");
    await expect(externalId(withoutCode)).resolves.toBe(OLD_ID);
    await expect(externalId(faceit)).resolves.toBe(OLD_ID);
    await expect(externalId(fiveStack)).resolves.toBe(OLD_ID);
    await expect(pending()).resolves.toEqual([
      {
        valve_match_id: CODES[1].valveMatchId,
        share_code: CODES[1].shareCode,
        status: "Parsing",
      },
    ]);
  });

  it("leaves a code that is not in Valve's alphabet alone", async () => {
    const player = await fx.player();
    const matchId = await seedMatch("valve", OLD_ID, NOT_VALVE_SHARE_CODE);
    await seedPending(OLD_ID, NOT_VALVE_SHARE_CODE, [player]);

    await postgres.query(up);

    await expect(externalId(matchId)).resolves.toBe(OLD_ID);
    await expect(pending()).resolves.toEqual([
      {
        valve_match_id: OLD_ID,
        share_code: NOT_VALVE_SHARE_CODE,
        status: "Queued",
      },
    ]);
    await expect(requesters(OLD_ID)).resolves.toEqual([player]);
  });

  it("gives Valve's match id to only the first of two imports of one match", async () => {
    const first = await seedMatch("valve", OLD_ID, SHARE_CODE);
    const second = await seedMatch(
      "valve",
      SAME_MATCH_OLD_ID,
      SAME_MATCH_SHARE_CODE,
    );

    await postgres.query(up);

    await expect(externalId(first)).resolves.toBe(VALVE_MATCH_ID);
    await expect(externalId(second)).resolves.toBe(SAME_MATCH_OLD_ID);
  });

  it("leaves a match alone when another already holds its Valve match id", async () => {
    const imported = await seedMatch(
      "valve",
      VALVE_MATCH_ID,
      SAME_MATCH_SHARE_CODE,
    );
    const before = await seedMatch("valve", OLD_ID, SHARE_CODE);

    await postgres.query(up);

    await expect(externalId(imported)).resolves.toBe(VALVE_MATCH_ID);
    await expect(externalId(before)).resolves.toBe(OLD_ID);
  });

  it("folds the second of two pending imports of one match into the first", async () => {
    const [first, second, both] = await fx.players(3);
    await seedPending(OLD_ID, SHARE_CODE, [first, both]);
    await seedPending(SAME_MATCH_OLD_ID, SAME_MATCH_SHARE_CODE, [second, both]);

    await postgres.query(up);

    await expect(pending()).resolves.toEqual([
      {
        valve_match_id: VALVE_MATCH_ID,
        share_code: SHARE_CODE,
        status: "Queued",
      },
    ]);
    await expect(requesters(VALVE_MATCH_ID)).resolves.toEqual(
      [first, second, both].sort(),
    );
    await expect(requesters(SAME_MATCH_OLD_ID)).resolves.toEqual([]);
  });

  it("folds a pending import into the one that already holds its Valve match id", async () => {
    const [first, second] = await fx.players(2);
    await seedPending(VALVE_MATCH_ID, SAME_MATCH_SHARE_CODE, [first]);
    await seedPending(OLD_ID, SHARE_CODE, [second]);

    await postgres.query(up);

    await expect(pending()).resolves.toEqual([
      {
        valve_match_id: VALVE_MATCH_ID,
        share_code: SAME_MATCH_SHARE_CODE,
        status: "Queued",
      },
    ]);
    await expect(requesters(VALVE_MATCH_ID)).resolves.toEqual(
      [first, second].sort(),
    );
  });

  it("imports a demo queued before the fix under Valve's match id", async () => {
    const player = await fx.player();
    await seedPending(OLD_ID, SHARE_CODE, [player], "Parsing", DEMO_URL);
    await postgres.query(up);
    const importExternalDemo = jest.fn(async () => ({
      matchId: "00000000-0000-0000-0000-000000000001",
    }));

    await parseJob(importExternalDemo).process({
      data: {
        valve_match_id: OLD_ID,
        share_code: SHARE_CODE,
        demo_url: DEMO_URL,
        match_start_time: null,
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);

    expect(importExternalDemo).toHaveBeenCalledWith(
      expect.anything(),
      "valve",
      SHARE_CODE,
      expect.objectContaining({ externalId: VALVE_MATCH_ID }),
    );
    await expect(pending()).resolves.toEqual([]);
  });

  it("clears a demo queued before the fix for a match imported before it", async () => {
    const player = await fx.player();
    await seedMatch("valve", OLD_ID, SHARE_CODE);
    await seedPending(OLD_ID, SHARE_CODE, [player], "Parsing", DEMO_URL);
    await postgres.query(up);
    const importExternalDemo = jest.fn();

    await parseJob(importExternalDemo).process({
      data: {
        valve_match_id: OLD_ID,
        share_code: SHARE_CODE,
        demo_url: DEMO_URL,
        match_start_time: null,
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);

    expect(importExternalDemo).not.toHaveBeenCalled();
    await expect(pending()).resolves.toEqual([]);
  });

  it("queues the resolve again for an import whose job was queued before the fix", async () => {
    const player = await fx.player();
    await seedPending(OLD_ID, SHARE_CODE, [player]);
    await postgres.query(up);
    const resolveShareCode = jest.fn();

    await new ResolveMatchMetadata(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      { isAvailable: () => true, resolveShareCode } as never,
      {} as never,
      { remove: jest.fn(), add: jest.fn() } as never,
    ).process({
      data: { valve_match_id: OLD_ID },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as never);

    expect(resolveShareCode).not.toHaveBeenCalled();

    await postgres.transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE pending_match_imports SET updated_at = now() - interval '1 hour'",
      );
    });
    const queue = resolveQueue();
    await new ReconcilePendingMatchImports(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      queue as never,
      { getJob: async (): Promise<undefined> => undefined } as never,
      service(queue),
    ).process();

    expect(queue.add).toHaveBeenCalledWith(
      "ResolveMatchMetadata",
      { valve_match_id: VALVE_MATCH_ID },
      expect.objectContaining({ jobId: `resolve-${VALVE_MATCH_ID}` }),
    );
    await expect(pending()).resolves.toEqual([
      {
        valve_match_id: VALVE_MATCH_ID,
        share_code: SHARE_CODE,
        status: "Queued",
      },
    ]);
  });
});
