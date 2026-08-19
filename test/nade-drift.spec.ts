import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  DemoParserService,
  ParsedDriftRequest,
  ParsedDriftResult,
} from "./../src/demos/demo-parser.service";
import { NadeDriftService } from "./../src/nades/nade-drift.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Drift is the only thing in the library that runs a simulator, and the one
// rule that governs all of it is that its numbers are differential. These pin
// what gets persisted (a verdict and a gap, never a coordinate), that a lineup
// with no seed is answered rather than skipped, and that a parser that is not
// there fails the scan honestly instead of taking a request down with it.
describe("nade drift scans (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let driftCalls: Array<ParsedDriftRequest>;
  let sent: Array<{ type: string; title: string; message: string }>;

  beforeAll(async () => {
    db = await bootMigratedDb("NadeDriftTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199660000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    driftCalls = [];
    sent = [];
    await postgres.query("DELETE FROM nade_drift_scans");
    await postgres.query("DELETE FROM nade_lineups");
    await postgres.query("DELETE FROM players");
  });

  const admin = (steamId: string): User =>
    ({ steam_id: steamId, role: "administrator", name: "op" }) as User;
  const player = (steamId: string): User =>
    ({ steam_id: steamId, role: "user", name: "player" }) as User;

  function parserStub(
    verdicts: (
      request: ParsedDriftRequest,
    ) => Array<ParsedDriftResult> | null = () => [],
  ) {
    return {
      drift: jest.fn(async (request: ParsedDriftRequest) => {
        driftCalls.push(request);
        const results = verdicts(request);

        if (results === null) {
          return {
            data: null as null,
            status: 503,
            error: "server busy",
          };
        }

        return {
          data: { results },
          status: 200,
          error: null as string | null,
        };
      }),
    } as unknown as DemoParserService;
  }

  function service(parser: DemoParserService) {
    return new NadeDriftService(
      new Logger("NadeDriftTest"),
      postgres,
      parser,
      {
        send: jest.fn(
          async (
            type: string,
            notification: { title: string; message: string },
          ): Promise<void> => {
            sent.push({ type, ...notification });
          },
        ),
      } as unknown as never,
      {
        get: jest.fn(() => ({ webDomain: "https://5stack.test" })),
      } as unknown as never,
    );
  }

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      nade_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: -560,
      land_y: 320,
      land_z: -140,
      name: "Window",
      visibility: "Public",
      author_steam_id: author,
      initial_pos_x: -1900,
      initial_pos_y: 930,
      initial_pos_z: -100,
      initial_vel_x: 500,
      initial_vel_y: 200,
      initial_vel_z: 300,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  const scanRow = async (scanId: string) => {
    const [row] = await postgres.query<
      Array<{
        status: string;
        lineups: number;
        scanned: number;
        unchanged: number;
        moved: number;
        broken: number;
        unsimulatable: number;
        max_distance: number | null;
        failure_reason: string | null;
        started_at: Date | null;
        finished_at: Date | null;
      }>
    >("SELECT * FROM nade_drift_scans WHERE id = $1::uuid", [scanId]);
    return row;
  };

  describe("starting a scan", () => {
    it("is administrators only", async () => {
      const who = await fx.player();

      await expect(
        service(parserStub()).startScan(player(who), {
          map_name: "de_mirage",
        }),
      ).rejects.toThrow("administrator");
    });

    it("counts the lineups it will judge", async () => {
      const author = await fx.player();
      await insertLineup(author);
      await insertLineup(author);
      await insertLineup(author, { archived_at: new Date().toISOString() });
      await insertLineup(author, { map_name: "de_nuke" });

      const scan = await service(parserStub()).startScan(admin(author), {
        map_name: "de_mirage",
        from_revision: "17595823-4",
      });

      expect(scan.lineups).toBe(2);

      const row = await scanRow(scan.scan_id);
      expect(row.status).toBe("Pending");
      expect(row.lineups).toBe(2);
    });

    it("refuses a map that does not exist", async () => {
      const author = await fx.player();

      await expect(
        service(parserStub()).startScan(admin(author), {
          map_name: "de_notamap",
        }),
      ).rejects.toThrow(/Unknown map/);
    });
  });

  describe("running a scan", () => {
    it("persists a verdict per lineup, unsimulatable included", async () => {
      const author = await fx.player();
      const unchanged = await insertLineup(author);
      const moved = await insertLineup(author);
      const seedless = await insertLineup(author, {
        initial_vel_x: null,
        initial_vel_y: null,
        initial_vel_z: null,
      });

      const drift = service(
        parserStub((request) =>
          request.lineups.map((lineup, index) => {
            if (!lineup.initial_velocity) {
              return {
                index,
                verdict: "unsimulatable" as const,
                reason: "no recorded initial_velocity",
              };
            }
            return lineup.id === moved
              ? {
                  index,
                  verdict: "moved" as const,
                  severity: "major",
                  distance: 91.5,
                  distance_xy: 90,
                  distance_z: 16,
                }
              : { index, verdict: "unchanged" as const };
          }),
        ),
      );

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });
      await drift.runScan(scan.scan_id);

      const rows = await postgres.query<
        Array<{
          nade_lineup_id: string;
          verdict: string;
          severity: string | null;
          distance: number | null;
        }>
      >(
        `SELECT nade_lineup_id::text AS nade_lineup_id, verdict, severity, distance
           FROM nade_drift_results WHERE nade_drift_scan_id = $1::uuid`,
        [scan.scan_id],
      );

      const verdicts = new Map(
        rows.map((row) => [row.nade_lineup_id, row.verdict]),
      );

      expect(verdicts.get(unchanged)).toBe("unchanged");
      expect(verdicts.get(moved)).toBe("moved");
      expect(verdicts.get(seedless)).toBe("unsimulatable");

      const row = await scanRow(scan.scan_id);
      expect(row.status).toBe("Finished");
      expect(row.scanned).toBe(3);
      expect(row.unchanged).toBe(1);
      expect(row.moved).toBe(1);
      expect(row.unsimulatable).toBe(1);
      expect(row.broken).toBe(0);
      expect(Number(row.max_distance)).toBeCloseTo(91.5, 5);
      expect(row.started_at).not.toBeNull();
      expect(row.finished_at).not.toBeNull();
    });

    it("sends a seedless lineup rather than deciding for the parser", async () => {
      const author = await fx.player();
      await insertLineup(author, {
        initial_pos_x: null,
        initial_pos_y: null,
        initial_pos_z: null,
        initial_vel_x: null,
        initial_vel_y: null,
        initial_vel_z: null,
      });

      const drift = service(
        parserStub((request) =>
          request.lineups.map((_, index) => ({
            index,
            verdict: "unsimulatable" as const,
          })),
        ),
      );

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });
      await drift.runScan(scan.scan_id);

      expect(driftCalls).toHaveLength(1);
      expect(driftCalls[0].lineups[0].initial_velocity).toBeUndefined();
      expect(driftCalls[0].lineups[0].initial_position).toBeUndefined();
    });

    it("translates the panel's grenade spelling into the simulator's", async () => {
      const author = await fx.player();
      await insertLineup(author, { nade_type: "HighExplosive" });
      await insertLineup(author, { nade_type: "Smoke" });

      const drift = service(
        parserStub((request) =>
          request.lineups.map((_, index) => ({
            index,
            verdict: "unchanged" as const,
          })),
        ),
      );

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });
      await drift.runScan(scan.scan_id);

      const types = driftCalls[0].lineups.map((lineup) => lineup.nade_type);
      expect(types).toContain("HE");
      expect(types).toContain("Smoke");
      expect(types).not.toContain("HighExplosive");
    });

    it("carries the mesh revisions the scan was started with", async () => {
      const author = await fx.player();
      await insertLineup(author);

      const drift = service(
        parserStub(() => [{ index: 0, verdict: "unchanged" as const }]),
      );

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
        from_revision: "17595823-4",
        to_revision: "17601122-1",
      });
      await drift.runScan(scan.scan_id);

      expect(driftCalls[0].from).toBe("17595823-4");
      expect(driftCalls[0].to).toBe("17601122-1");
    });

    it("fails the scan with a reason when the parser is down", async () => {
      const author = await fx.player();
      await insertLineup(author);

      const drift = service(parserStub(() => null));

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });

      await expect(drift.runScan(scan.scan_id)).resolves.toBeUndefined();

      const row = await scanRow(scan.scan_id);
      expect(row.status).toBe("Failed");
      expect(row.failure_reason).toBe("server busy");
      expect(row.finished_at).not.toBeNull();
    });

    it("refuses to run the same scan twice", async () => {
      const author = await fx.player();
      await insertLineup(author);

      const drift = service(
        parserStub(() => [{ index: 0, verdict: "unchanged" as const }]),
      );

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });
      await drift.runScan(scan.scan_id);
      await drift.runScan(scan.scan_id);

      expect(driftCalls).toHaveLength(1);
    });

    it("stores no coordinate, only the gap between the two runs", async () => {
      const author = await fx.player();
      await insertLineup(author);

      const drift = service(
        parserStub(() => [
          {
            index: 0,
            verdict: "moved" as const,
            severity: "minor",
            distance: 12,
            distance_xy: 11,
            distance_z: 4,
          },
        ]),
      );

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });
      await drift.runScan(scan.scan_id);

      const columns = await postgres.query<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'nade_drift_results'
          ORDER BY column_name`,
      );

      // distance_z is a magnitude, not an altitude. The simulator's own
      // endpoints (comparison_point) are deliberately absent: they are only
      // meaningful subtracted from each other, and a coordinate on a screen
      // reads as "where your nade lands".
      expect(columns.map((column) => column.column_name)).toEqual([
        "created_at",
        "distance",
        "distance_xy",
        "distance_z",
        "nade_drift_scan_id",
        "nade_lineup_id",
        "reason",
        "severity",
        "verdict",
      ]);
    });
  });
  // A scan nobody hears about is the failure the feature exists to prevent: a
  // map patch quietly rots the library and the first anyone knows is a smoke
  // landing in the wrong place in a match.
  describe("announcing the outcome", () => {
    it("tells administrators the headline counts", async () => {
      const author = await fx.player();
      const moved = await insertLineup(author);
      await insertLineup(author);

      const drift = service(
        parserStub((request) =>
          request.lineups.map((lineup, index) =>
            lineup.id === moved
              ? {
                  index,
                  verdict: "moved" as const,
                  severity: "major",
                  distance: 91.5,
                }
              : { index, verdict: "unchanged" as const },
          ),
        ),
      );

      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });
      await drift.runScan(scan.scan_id);

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe("NadeDriftScanFinished");
      expect(sent[0].title).toContain("de_mirage");
      expect(sent[0].message).toContain("<b>1</b> moved");
      expect(sent[0].message).toContain("<b>1</b> unchanged");
      expect(sent[0].message).toContain("<b>92</b> units");
      expect(sent[0].message).toContain("https://5stack.test/nades/drift");
    });

    it("says so when the scan never finished", async () => {
      const author = await fx.player();
      await insertLineup(author);

      const drift = service(parserStub(() => null));
      const scan = await drift.startScan(admin(author), {
        map_name: "de_mirage",
      });
      await drift.runScan(scan.scan_id);

      expect(sent).toHaveLength(1);
      expect(sent[0].title).toContain("failed");
      expect(sent[0].message).toContain("server busy");
    });
  });
});
