import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "graphql";
import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { TelemetryService } from "./../src/telemetry/telemetry.service";
import { TelemetryPayload } from "./../src/telemetry/types/TelemetryPayload";

// Both halves of the telemetry loop run against a real migrated schema: the
// sender's collect() query (every column name and join it touches) and the
// receiver's sanitize -> persist -> aggregate path over the jsonb payloads.
class TelemetryTest {
  // Unwraps `[Foo!]!` down to `Foo`.
  static namedType(node: any): string {
    return node.kind === "NamedType"
      ? node.name.value
      : TelemetryTest.namedType(node.type);
  }
}

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

      // Enabling a node pre-provisions a `servers` row per port pair in its
      // range, so this seeds five rows that are slots, not servers.
      await postgres.query(
        `INSERT INTO game_server_nodes
           (id, public_ip, start_port_range, end_port_range, region, status, enabled, label)
         VALUES ('telemetry-node', '203.0.113.1', 27015, 27025, 'TelemetryRegion', 'Online', true, 'telemetry-node')`,
      );

      const ran = await fx.bareMatch(new Date().toISOString());
      await postgres.query(
        `UPDATE matches SET started_at = now(), status = 'Live', match_options_id = $2
          WHERE id = $1`,
        [ran.matchId, await fx.matchOptions({ type: "Wingman" })],
      );

      // Never started: must land in `created` but not in `total` or the windows.
      await fx.bareMatch();

      // An imported FACEIT demo. The importer stamps a started_at, so without
      // the source split this reads as a match the panel hosted.
      const imported = await fx.bareMatch(new Date().toISOString());
      await postgres.query(
        `UPDATE matches
            SET started_at = now(), source = 'faceit', external_id = $2,
                status = 'Finished', match_options_id = $3
          WHERE id = $1`,
        [imported.matchId, "faceit-1", await fx.matchOptions()],
      );

      // A demo played on a 5stack server and imported back in keeps
      // source = '5stack'; external_id is the only thing separating it.
      const reimported = await fx.bareMatch(new Date().toISOString());
      await postgres.query(
        "UPDATE matches SET started_at = now(), external_id = $2 WHERE id = $1",
        [reimported.matchId, "5stack-1"],
      );

      // Only the first of these ever signed in; the other two are the rows a
      // panel creates for a steam id it saw in a lineup or a demo.
      const signedIn = await fx.player("signed-in");
      const ghost = await fx.player("ghost");
      await fx.player("never-seen-again");

      await postgres.query(
        "UPDATE players SET last_sign_in_at = now() WHERE steam_id = $1",
        [signedIn],
      );

      await postgres.query(
        `INSERT INTO player_match_map_stats (steam_id, match_map_id, match_id, kills)
         VALUES ($1, $3, $4, 10), ($2, $3, $4, 4)`,
        [signedIn, ghost, ran.mapId, ran.matchId],
      );

      // Two people watched a demo back; nobody uploaded one. Demo playback used
      // to be reported as the stored-demo count, which made these one number.
      await postgres.query(
        `INSERT INTO match_demo_sessions
           (match_map_id, match_id, watcher_steam_id, k8s_job_name)
         VALUES ($1, $2, $3, 'demo-a'), ($1, $2, $4, 'demo-b')`,
        [ran.mapId, ran.matchId, signedIn, ghost],
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

    it("breaks the hosted matches down by type without folding imports in", () => {
      // The hosted match is Wingman, the imported one Competitive. Counting
      // every started match put the import in here as a match we ran.
      expect(payload.matches.by_type).toEqual({ Wingman: 1 });
      expect(payload.matches.by_source.faceit).toBe(1);
    });

    it("decomposes the matches it ran into an outcome", () => {
      // The one match this panel ran is still live; the Finished one is the
      // import, and an import is never an outcome the panel produced.
      expect(payload.matches.live).toBe(1);
      expect(payload.matches.finished).toBe(0);
      expect(payload.matches.abandoned).toBe(0);
    });

    it("keeps a node's pre-provisioned port slots out of the server count", async () => {
      const [rows] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*) FROM servers",
      );

      // Six rows: the region fixture's dedicated server plus the node's five
      // port slots. Only the dedicated one is a server anybody runs.
      expect(Number(rows.count)).toBe(6);
      expect(payload.servers.total).toBe(1);
      expect(payload.servers.dedicated).toBe(1);
    });

    it("counts only players who have signed in as registered", () => {
      expect(payload.players.known).toBe(3);
      expect(payload.players.registered).toBe(1);
    });

    it("counts players with stats on at least one map as having played", () => {
      expect(payload.players.played).toBe(2);
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
      // Auto highlights is gated by an unprefixed `auto_generate_match_clips`.
      expect(payload.features.highlights.enabled).toBe(false);
      // GPU workloads are switched per node, not by a setting.
      expect(payload.features.demo_playback.enabled).toBe(false);
      expect(payload.features.clip_renders.enabled).toBe(false);
    });

    // Each of these ships on and an admin has to switch it off, so a panel that
    // has never touched the setting has to report it enabled.
    it("defaults a flag to whatever the app itself does with no settings row", () => {
      expect(payload.features.matchmaking.enabled).toBe(true);
      expect(payload.features.stream_login_protection.enabled).toBe(true);
      expect(payload.features.steam_presence.enabled).toBe(true);
      expect(payload.features.voice_chat.enabled).toBe(true);
    });

    it("separates a feature nothing counts from one counted at zero", () => {
      // Nothing measures these, and reporting 0 would read as nobody using them.
      expect(payload.features.stream_login_protection.count).toBeNull();
      expect(payload.features.clip_branding.count).toBeNull();
      expect(payload.features.branding.count).toBeNull();

      // These do have a metric, and it happens to be zero here.
      expect(payload.features.events.count).toBe(0);
      expect(payload.features.sanctions.count).toBe(0);
    });

    it("counts the things a capability is measured by rather than nothing", () => {
      // One node is seeded, and it is what "game server nodes" adoption means.
      expect(payload.features.game_server_nodes.count).toBe(1);
      expect(payload.features.version_pinning.count).toBe(0);

      // Playback sessions, not stored demos: the two used to be one number.
      expect(payload.features.demo_playback.count).toBe(2);
      expect(payload.features.demos.count).toBe(0);
      expect(payload.features.live_streaming.count).toBe(0);
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
      schema: 2,
      install_id: install,
      installed_at: "2024-01-01T00:00:00.000Z",
      panel_version: "deadbeef",
      plugin_runtime: "swiftly",
      nodes: { total: 2, enabled: 2, online: 1, regions: 1, gpu: 1 },
      servers: {
        total: 10,
        enabled: 9,
        dedicated: 3,
        public: 4,
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
      players: {
        known: 900,
        registered: 300,
        played: 210,
        active_7d: 40,
        active_30d: 90,
        teams: 22,
      },
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
      schema: 2,
      install_id: installId,
      installed_at: "2024-01-01T00:00:00.000Z",
      panel_version: "cafebabe",
      plugin_runtime: "css",
      nodes: { total: 1, enabled: 1, online: 1, regions: 1, gpu: 1 },
      servers: {
        total: servers,
        enabled: servers,
        dedicated: 1,
        public: 2,
      },
      matches: {
        total: matches,
        created: matches,
        week: 5,
        month: 20,
        year: 100,
        maps_played: matches * 2,
        finished: matches - 5,
        abandoned: 3,
        live: 2,
        by_type: { Competitive: matches, Wingman: 10 },
        by_source: { "5stack": matches, faceit: matches / 10 },
        tournament: 1,
        league: 0,
        scrim: 2,
        external: { total: matches / 10, week: 0, month: 2, year: 5 },
      },
      players: {
        known: 200,
        registered: 50,
        played: 35,
        active_7d: 5,
        active_30d: 12,
        teams: 3,
      },
      features: {
        events: { enabled: installId === installA, count: 3 },
        highlights: { enabled: null as boolean | null, count: 10 },
        // Ships with every panel: no switch, usage only.
        tournaments: { enabled: null as boolean | null, count: 7 },
        // A switch nothing measures, and a capability read back rather than set.
        stream_login_protection: {
          enabled: true,
          count: null as number | null,
        },
        branding: { enabled: true, count: null as number | null },
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
      expect(stats.totals.mapsPlayed).toBe(700);
      expect(stats.totals.playersKnown).toBe(400);
      expect(stats.totals.playersRegistered).toBe(100);
      expect(stats.totals.playersPlayed).toBe(70);
      // Imported matches are summed apart from the ones the panels hosted.
      expect(stats.totals.matchesImported).toBe(35);
      expect(stats.totals.matchesImportedMonth).toBe(4);

      // The denominator every total above is over.
      expect(stats.totals.panels).toBe(2);
      expect(stats.totals.gameServerNodesOnline).toBe(2);
      expect(stats.totals.serversEnabled).toBe(10);
      expect(stats.totals.matchesTournament).toBe(2);
      expect(stats.totals.matchesScrim).toBe(4);
      expect(stats.totals.playersActive7d).toBe(10);
      expect(stats.totals.matchesAbandoned).toBe(6);
      expect(stats.totals.matchesLive).toBe(4);
    });

    it("says how many panels are old enough to report match outcomes", async () => {
      // A panel on the previous payload sends no outcome fields at all.
      const legacy = report(installA, 100, 4) as Record<string, any>;
      delete legacy.matches.finished;
      delete legacy.matches.abandoned;
      delete legacy.matches.live;

      await service.record("203.0.113.1", "US", legacy);

      const stats = await service.getFleetStats();

      // installB still reports them; installA no longer does. Counting the
      // absent one as a zero would quietly halve the fleet's finished total.
      expect(stats.totals.outcomesReported).toBe(1);
      expect(stats.totals.matchesFinished).toBe(245);

      const [row] = await postgres.query<Array<{ payload: any }>>(
        "SELECT payload FROM telemetry_installs WHERE install_id = $1",
        [installA],
      );

      expect(row.payload.matches.finished).toBeNull();
    });

    it("adds up the match type and source mixes across the fleet", async () => {
      const stats = await service.getFleetStats();

      const types = new Map(stats.matchTypes.map((r) => [r.type, r.matches]));
      expect(types.get("Competitive")).toBe(350);
      expect(types.get("Wingman")).toBe(20);

      const sources = new Map(
        stats.matchSources.map((r) => [r.source, r.matches]),
      );
      expect(sources.get("5stack")).toBe(350);
      expect(sources.get("faceit")).toBe(35);

      // Ordered by volume so the page can slice a top N off the front.
      expect(stats.matchTypes[0].type).toBe("Competitive");
      expect(stats.matchTypes[0].panels).toBe(2);
    });

    it("breaks the fleet down by version, runtime and country", async () => {
      const stats = await service.getFleetStats();

      expect(stats.versions).toEqual([{ version: "cafebabe", installs: 2 }]);
      expect(stats.runtimes).toEqual([{ runtime: "css", installs: 2 }]);
      expect(stats.countries).toEqual([
        { country: "DE", installs: 1 },
        { country: "US", installs: 1 },
      ]);
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
      expect(highlights.counted).toBe(2);
      expect(highlights.total).toBe(20);
    });

    it("marks a feature nothing measures instead of reporting nobody uses it", async () => {
      const stats = await service.getFleetStats();
      const gated = stats.features.find(
        (f) => f.key === "stream_login_protection",
      );

      // Both panels reported it on; neither reported a usage number. Without
      // `counted` this is indistinguishable from "0 of 2 panels using it".
      expect(gated.reporting).toBe(2);
      expect(gated.enabled).toBe(2);
      expect(gated.counted).toBe(0);
      expect(gated.installsUsing).toBe(0);
    });

    it("says whether a feature is a setting, a capability, or always on", async () => {
      const stats = await service.getFleetStats();
      const kind = (key: string) =>
        stats.features.find((f) => f.key === key)?.kind;

      expect(kind("events")).toBe("setting");
      expect(kind("stream_login_protection")).toBe("setting");
      // Derived from whether a brand was filled in, so there is no switch to
      // report an adoption rate for.
      expect(kind("branding")).toBe("detected");
      // Stored as a setting -- which is where its `enabled` comes from -- but
      // written from whether Discord credentials are configured, not by an
      // admin. Being in both maps is what made this read as a toggle.
      expect(kind("discord_bot")).toBe("detected");
      expect(kind("game_server_nodes")).toBe("detected");
      expect(kind("version_pinning")).toBe("detected");
      // Auto highlights does have a switch, even though this fixture reports
      // no flag for it — the classification comes from the catalog, not the row.
      expect(kind("highlights")).toBe("setting");
      expect(kind("tournaments")).toBe("always");
    });

    // A field the page selects but the handler never returns comes back null and
    // renders as an empty stat, which is indistinguishable from a real zero.
    // Walk the action's declared shape against what actually comes out.
    it("returns every field the telemetryStats action declares", async () => {
      const sdl = parse(
        readFileSync(
          join(__dirname, "..", "hasura", "metadata", "actions.graphql"),
          "utf8",
        ),
      );

      const types = new Map<string, Map<string, string>>();

      for (const definition of sdl.definitions) {
        if (definition.kind !== "ObjectTypeDefinition") {
          continue;
        }

        types.set(
          definition.name.value,
          new Map(
            (definition.fields ?? []).map((field) => [
              field.name.value,
              TelemetryTest.namedType(field.type),
            ]),
          ),
        );
      }

      const problems: Array<string> = [];

      const walk = (typeName: string, value: unknown, path: string) => {
        const fields = types.get(typeName);

        if (!fields) {
          return;
        }

        if (Array.isArray(value)) {
          if (!value.length) {
            problems.push(`${path} came back empty, so it proves nothing`);
            return;
          }

          walk(typeName, value[0], `${path}[0]`);
          return;
        }

        if (!value || typeof value !== "object") {
          problems.push(`${path} is ${JSON.stringify(value)}`);
          return;
        }

        const row = value as Record<string, unknown>;

        for (const [field, fieldType] of fields) {
          if (!(field in row)) {
            problems.push(`${path}.${field} is missing`);
            continue;
          }

          walk(fieldType, row[field], `${path}.${field}`);
        }

        for (const key of Object.keys(row)) {
          if (!fields.has(key)) {
            problems.push(`${path}.${key} is returned but not declared`);
          }
        }
      };

      walk("TelemetryStats", await service.getFleetStats(), "telemetryStats");

      expect(problems).toEqual([]);
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
