import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { TelemetryService } from "./../src/telemetry/telemetry.service";
import { TelemetryPayload } from "./../src/telemetry/types/TelemetryPayload";

// Both halves of the telemetry loop run against a real migrated schema: the
// sender's collect() query (every column name and join it touches) and the
// receiver's sanitize -> persist -> aggregate path over the jsonb payloads.
describe("telemetry (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let service: TelemetryService;
  let redis: { setex: jest.Mock; scan: jest.Mock };

  beforeAll(async () => {
    db = await bootMigratedDb("TelemetryTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561193000000000n);

    redis = {
      setex: jest.fn().mockResolvedValue("OK"),
      scan: jest.fn().mockResolvedValue(["0", []]),
    };

    service = new TelemetryService(
      new Logger("TelemetryTest"),
      { getConnection: () => redis } as never,
      null as never,
      { get: () => ({ webDomain: "https://panel.test" }) } as never,
      postgres,
      { getPanelVersion: async () => "abcdef1234567890" } as never,
      // Pass-through so the aggregation SQL runs on every assertion.
      {
        remember: async (_key: string, callback: () => Promise<unknown>) =>
          await callback(),
      } as never,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM telemetry_snapshots");
    await postgres.query("DELETE FROM telemetry_installs");
    redis.setex.mockClear();
  });

  describe("collect", () => {
    let payload: TelemetryPayload;

    beforeAll(async () => {
      await fx.region("TelemetryRegion");

      const ran = await fx.bareMatch(new Date().toISOString());
      await postgres.query(
        "UPDATE matches SET started_at = now() WHERE id = $1",
        [ran.matchId],
      );

      // Never started: must land in `created` but not in `total` or the windows.
      await fx.bareMatch();

      // An imported FACEIT demo. The importer stamps a started_at, so without
      // the source split this reads as a match the panel hosted.
      const imported = await fx.bareMatch(new Date().toISOString());
      await postgres.query(
        `UPDATE matches SET started_at = now(), source = 'faceit', external_id = $2
          WHERE id = $1`,
        [imported.matchId, "faceit-1"],
      );

      // A demo played on a 5stack server and imported back in keeps
      // source = '5stack'; external_id is the only thing separating it.
      const reimported = await fx.bareMatch(new Date().toISOString());
      await postgres.query(
        "UPDATE matches SET started_at = now(), external_id = $2 WHERE id = $1",
        [reimported.matchId, "5stack-1"],
      );

      payload = await service.collect();
    }, 600_000);

    it("runs every counter query against the real schema", () => {
      expect(payload.schema).toBeGreaterThan(0);
      expect(payload.install_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(payload.panel_version).toBe("abcdef1234567890");
    });

    it("counts only started matches as ran, and every row as created", () => {
      expect(payload.matches.created).toBe(4);
      expect(payload.matches.total).toBe(1);
      expect(payload.matches.week).toBe(1);
      expect(payload.matches.month).toBe(1);
      expect(payload.matches.year).toBe(1);
    });

    it("keeps imported matches out of the matches the panel ran", () => {
      expect(payload.matches.external.total).toBe(2);
      expect(payload.matches.external.week).toBe(2);
      expect(payload.matches.external.year).toBe(2);

      // by_source stays whole-fleet so the origin mix is still visible.
      expect(payload.matches.by_source.faceit).toBe(1);
    });

    it("reports the servers seeded by the region fixture", () => {
      expect(payload.servers.total).toBeGreaterThanOrEqual(1);
      expect(payload.servers.dedicated).toBeGreaterThanOrEqual(1);
    });

    it("reports every feature with an enabled flag or a usage count", () => {
      for (const key of [
        "tournaments",
        "leagues",
        "seasons",
        "events",
        "news",
        "highlights",
        "system_alerts",
        "awards",
        "scrims",
        "matchmaking",
        "custom_pages",
        "branding",
      ]) {
        expect(payload.features[key]).toBeDefined();
      }

      // Absent settings rows must resolve to the app's own default, not null.
      expect(payload.features.events.enabled).toBe(false);
      expect(payload.features.scrims.enabled).toBe(true);
      expect(payload.features.highlights.count).toBe(0);
    });

    it("keeps the install id out of the guest-readable settings namespace", async () => {
      const rows = await postgres.query<Array<{ name: string }>>(
        "SELECT name FROM settings WHERE value = $1",
        [payload.install_id],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].name.startsWith("public.")).toBe(false);
    });

    it("returns the same install id on every collection", async () => {
      const again = await service.collect();
      expect(again.install_id).toBe(payload.install_id);
    });
  });

  describe("record", () => {
    const install = "11111111-2222-3333-4444-555555555555";

    const report = (over: Record<string, any> = {}) => ({
      schema: 1,
      install_id: install,
      installed_at: "2024-01-01T00:00:00.000Z",
      panel_version: "deadbeef",
      plugin_runtime: "swiftly",
      nodes: { total: 2, enabled: 2, online: 1, regions: 1 },
      servers: {
        total: 10,
        enabled: 9,
        dedicated: 3,
        on_demand: 7,
        public: 4,
        capacity: 120,
      },
      matches: {
        total: 500,
        created: 520,
        week: 12,
        month: 40,
        year: 300,
        maps_played: 700,
        by_type: { Competitive: 480, Wingman: 20 },
        by_source: { "5stack": 500 },
        tournament: 60,
        league: 10,
        scrim: 25,
        external: { total: 30, week: 1, month: 3, year: 12 },
      },
      players: { registered: 300, active_7d: 40, active_30d: 90, teams: 22 },
      features: {
        events: { enabled: true, count: 4 },
        news: { enabled: false, count: 0 },
        highlights: { enabled: null as boolean | null, count: 88 },
      },
      ...over,
    });

    it("persists an install and its daily snapshot", async () => {
      await service.record("203.0.113.7", "US", report());

      const [row] = await postgres.query<Array<Record<string, any>>>(
        "SELECT * FROM telemetry_installs WHERE install_id = $1",
        [install],
      );

      expect(row.panel_version).toBe("deadbeef");
      expect(row.country).toBe("US");
      expect(row.payload.matches.total).toBe(500);

      const snapshots = await postgres.query<Array<Record<string, any>>>(
        "SELECT * FROM telemetry_snapshots WHERE install_id = $1",
        [install],
      );

      expect(snapshots).toHaveLength(1);
    });

    it("keeps one snapshot per install per day and keeps first_seen_at", async () => {
      await service.record("203.0.113.7", "US", report());

      const [first] = await postgres.query<Array<{ first_seen_at: Date }>>(
        "SELECT first_seen_at FROM telemetry_installs WHERE install_id = $1",
        [install],
      );

      await service.record(
        "203.0.113.7",
        "US",
        report({ matches: { ...report().matches, total: 600 } }),
      );

      const [row] = await postgres.query<
        Array<{ first_seen_at: Date; payload: any }>
      >("SELECT * FROM telemetry_installs WHERE install_id = $1", [install]);

      expect(row.first_seen_at).toEqual(first.first_seen_at);
      expect(row.payload.matches.total).toBe(600);

      const snapshots = await postgres.query<Array<Record<string, any>>>(
        "SELECT * FROM telemetry_snapshots WHERE install_id = $1",
        [install],
      );

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].payload.matches.total).toBe(600);
    });

    it("counts a payload-less legacy panel as online without persisting it", async () => {
      await service.record("203.0.113.9", "CA", {});

      expect(redis.setex).toHaveBeenCalledWith(
        "online_system:203.0.113.9",
        3600,
        "{}",
      );

      const rows = await postgres.query<Array<unknown>>(
        "SELECT install_id FROM telemetry_installs",
      );

      expect(rows).toHaveLength(0);
    });

    it("clamps and strips forged input", async () => {
      await service.record("203.0.113.7", "US", {
        ...report(),
        evil: "DROP TABLE",
        nodes: { total: -5, enabled: "1e400", online: 1, regions: 1 },
        matches: { ...report().matches, total: 10_000_000_000 },
      });

      const [row] = await postgres.query<Array<{ payload: any }>>(
        "SELECT payload FROM telemetry_installs WHERE install_id = $1",
        [install],
      );

      expect(row.payload.evil).toBeUndefined();
      expect(row.payload.nodes.total).toBe(0);
      expect(row.payload.matches.total).toBe(100_000_000);
    });

    it("rejects a report with no usable install id", async () => {
      await service.record("203.0.113.8", "US", {
        ...report(),
        install_id: "not-a-uuid",
      });

      const rows = await postgres.query<Array<unknown>>(
        "SELECT install_id FROM telemetry_installs",
      );

      expect(rows).toHaveLength(0);
    });
  });

  describe("getFleetStats", () => {
    const installA = "aaaaaaaa-0000-4000-8000-000000000001";
    const installB = "bbbbbbbb-0000-4000-8000-000000000002";

    const report = (installId: string, matches: number, servers: number) => ({
      schema: 1,
      install_id: installId,
      installed_at: "2024-01-01T00:00:00.000Z",
      panel_version: "cafebabe",
      plugin_runtime: "css",
      nodes: { total: 1, enabled: 1, online: 1, regions: 1 },
      servers: {
        total: servers,
        enabled: servers,
        dedicated: 1,
        on_demand: servers - 1,
        public: 2,
        capacity: servers * 10,
      },
      matches: {
        total: matches,
        created: matches,
        week: 5,
        month: 20,
        year: 100,
        maps_played: matches * 2,
        by_type: { Competitive: matches },
        by_source: { "5stack": matches },
        tournament: 1,
        league: 0,
        scrim: 2,
        external: { total: matches / 10, week: 0, month: 2, year: 5 },
      },
      players: { registered: 50, active_7d: 5, active_30d: 12, teams: 3 },
      features: {
        events: { enabled: installId === installA, count: 3 },
        highlights: { enabled: null as boolean | null, count: 10 },
      },
    });

    beforeEach(async () => {
      await service.record("203.0.113.1", "US", report(installA, 100, 4));
      await service.record("203.0.113.2", "DE", report(installB, 250, 6));
    });

    it("sums the latest payload of every recently active install", async () => {
      const stats = await service.getFleetStats();

      expect(stats.installs.total).toBe(2);
      expect(stats.installs.active24h).toBe(2);
      expect(stats.totals.matches).toBe(350);
      expect(stats.totals.servers).toBe(10);
      expect(stats.totals.serverCapacity).toBe(100);
      expect(stats.totals.mapsPlayed).toBe(700);
      // Imported matches are summed apart from the ones the panels hosted.
      expect(stats.totals.matchesImported).toBe(35);
      expect(stats.totals.matchesImportedMonth).toBe(4);
    });

    it("reports feature adoption across installs", async () => {
      const stats = await service.getFleetStats();
      const events = stats.features.find((f) => f.key === "events");
      const highlights = stats.features.find((f) => f.key === "highlights");

      expect(events.reporting).toBe(2);
      expect(events.enabled).toBe(1);
      expect(events.total).toBe(6);

      // No flag, so nothing is "enabled" — adoption is the count alone.
      expect(highlights.enabled).toBe(0);
      expect(highlights.installsUsing).toBe(2);
      expect(highlights.total).toBe(20);
    });

    it("groups installs by first-seen month", async () => {
      const stats = await service.getFleetStats();

      expect(stats.growth).toHaveLength(1);
      expect(stats.growth[0].installs).toBe(2);
    });

    it("derives daily matches from the counter delta, never going negative", async () => {
      await postgres.query(
        `INSERT INTO telemetry_snapshots (install_id, day, payload)
         VALUES ($1, current_date - 2, $2), ($1, current_date - 1, $3)`,
        [
          installA,
          JSON.stringify(report(installA, 40, 4)),
          JSON.stringify(report(installA, 70, 4)),
        ],
      );

      // A wiped database reports a counter below the previous day's.
      await postgres.query(
        `INSERT INTO telemetry_snapshots (install_id, day, payload)
         VALUES ($1, current_date - 1, $2)`,
        [installB, JSON.stringify(report(installB, 900, 6))],
      );

      const stats = await service.getFleetStats();
      const byDay = new Map(stats.activity.map((point) => [point.day, point]));

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const key = yesterday.toISOString().slice(0, 10);

      // installA: 70 - 40 = 30. installB has no prior day, so it contributes 0.
      expect(byDay.get(key).matches).toBe(30);
      expect(byDay.get(key).installs).toBe(2);

      const today = new Date().toISOString().slice(0, 10);
      // installB drops 900 -> 250; the clamp keeps it at 0 rather than negative.
      expect(byDay.get(today).matches).toBe(30);
    });
  });
});
