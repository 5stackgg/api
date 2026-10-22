import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Pins the download and playback links a demo row resolves to.
describe("demo urls", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let matchId: string;
  let matchMapId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("DemoUrlsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199720000000n);
    await fx.region();
    ({ matchId, mapId: matchMapId } = await fx.bareMatch());
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM match_map_demos");
    await postgres.query(
      "DELETE FROM settings WHERE name IN ('cloudflare_worker_url', 'demos_domain')",
    );
  });

  async function settings(values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      await postgres.query(
        "INSERT INTO settings (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value",
        [name, value],
      );
    }
  }

  async function demo(overrides: Record<string, unknown>) {
    const row = {
      file: "demos/a.dem",
      match_id: matchId,
      match_map_id: matchMapId,
      created_at: "2026-01-02T03:04:05.6Z",
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_map_demos (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  async function urls(id: string) {
    const [row] = await postgres.query<
      Array<{ download: string | null; playback: string | null }>
    >(
      `SELECT public.demo_download_url(d) AS download, public.demo_playback_url(d) AS playback
         FROM match_map_demos d WHERE d.id = $1`,
      [id],
    );
    return row;
  }

  const CREATED_EPOCH = String(
    Math.round(Date.parse("2026-01-02T03:04:05.6Z") / 1000),
  );
  const PARSED_AT = "2026-02-03T04:05:06Z";
  const PARSED_EPOCH = String(Date.parse(PARSED_AT) / 1000);

  it("hands back an external demo link as it is, whatever the settings", async () => {
    for (const values of [
      {},
      { demos_domain: "https://demos.example.test" },
      { cloudflare_worker_url: "https://cf.example.test" },
    ]) {
      await settings(values);
      const http = await demo({ file: "http://replay.valve.test/1.dem.bz2" });
      const https = await demo({ file: "HTTPS://replay.valve.test/2.dem.bz2" });
      expect((await urls(http)).download).toBe(
        "http://replay.valve.test/1.dem.bz2",
      );
      expect((await urls(https)).download).toBe(
        "HTTPS://replay.valve.test/2.dem.bz2",
      );
      await postgres.query("DELETE FROM match_map_demos");
    }
  });

  it("serves stored demos through the worker when one is set", async () => {
    await settings({
      cloudflare_worker_url: "https://cf.example.test",
      demos_domain: "https://demos.example.test",
    });
    const id = await demo({
      playback_file: "playback/a.json.gz",
      metadata_parsed_at: PARSED_AT,
    });
    expect(await urls(id)).toEqual({
      download: `https://cf.example.test/demo?file=demos/a.dem&v=${CREATED_EPOCH}`,
      playback: `https://cf.example.test/demo?file=playback/a.json.gz&v=${PARSED_EPOCH}`,
    });
  });

  it("serves stored demos from the demos domain without a worker", async () => {
    await settings({ demos_domain: "https://demos.example.test" });
    const id = await demo({
      playback_file: "playback/a.json.gz",
      metadata_parsed_at: PARSED_AT,
    });
    expect(await urls(id)).toEqual({
      download: `https://demos.example.test/demos/${matchId}/map/${matchMapId}?v=${CREATED_EPOCH}`,
      playback: `https://demos.example.test/demos/${matchId}/map/${matchMapId}/playback?v=${PARSED_EPOCH}`,
    });
  });

  it("has no link without a worker or a demos domain", async () => {
    const id = await demo({
      playback_file: "playback/a.json.gz",
      metadata_parsed_at: PARSED_AT,
    });
    expect(await urls(id)).toEqual({ download: null, playback: null });
  });

  it("has no playback link before the demo is parsed into one", async () => {
    await settings({ cloudflare_worker_url: "https://cf.example.test" });
    const unparsed = await demo({});
    expect((await urls(unparsed)).playback).toBeNull();

    const undated = await demo({
      file: "demos/b.dem",
      playback_file: "playback/b.json.gz",
    });
    expect((await urls(undated)).playback).toBe(
      "https://cf.example.test/demo?file=playback/b.json.gz&v=0",
    );
  });
});
