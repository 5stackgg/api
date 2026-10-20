import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityCalloutsService } from "./../src/utility/utility-callouts.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Where a map's callouts come from, and which source wins. The published
// extract is deterministic and reviewable; a plugin report is whatever one
// server happened to see, so it may only ever fill a gap.
describe("map callouts (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("MapCalloutsTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const originalCdn = process.env.MAP_MESH_CDN;
  const originalFetch = global.fetch;

  let published: Record<string, ReturnType<typeof callouts>>;
  let fetched: Array<string>;

  beforeEach(async () => {
    await postgres.query("DELETE FROM map_callouts");

    process.env.MAP_MESH_CDN = "https://cdn.test/maps";
    published = {};
    fetched = [];
    global.fetch = jest.fn(async (url: string) => {
      fetched.push(url);
      const extract =
        published[
          url
            .replace("https://cdn.test/maps/", "")
            .replace(".callouts.json", "")
        ];
      return {
        ok: !!extract,
        status: extract ? 200 : 404,
        json: async () => ({ callouts: extract }),
      };
    }) as never;
  });

  afterEach(() => {
    if (originalCdn === undefined) {
      delete process.env.MAP_MESH_CDN;
    } else {
      process.env.MAP_MESH_CDN = originalCdn;
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const service = () =>
    new UtilityCalloutsService(new Logger("MapCalloutsTest"), postgres);

  const callouts = (...names: Array<string>) =>
    names.map((name) => ({
      name,
      boxes: [{ min: [0, 0, 0], max: [100, 100, 100] } as never],
    }));

  async function rows(map = "de_mirage") {
    return await postgres.query<Array<{ name: string; source: string }>>(
      "SELECT name, source FROM map_callouts WHERE map_name = $1 ORDER BY name",
      [map],
    );
  }

  async function seedCdn(map: string, ...names: Array<string>) {
    await postgres.query(
      `INSERT INTO public.map_callouts (map_name, name, boxes, source)
       SELECT $1, entry->>'name', entry->'boxes', 'cdn'
         FROM jsonb_array_elements($2::jsonb) AS entry`,
      [map, JSON.stringify(callouts(...names))],
    );
  }

  it("stores what a server reports for a map nobody has extracted", async () => {
    const result = await service().report(
      "de_mirage",
      callouts("Window", "Palace"),
    );

    expect(result.stored).toBe(2);
    expect((await rows()).map(({ name }) => name)).toEqual(["Palace", "Window"]);
  });

  // The extract is only pulled on a CS2 build change, so an install that turned
  // utility on between builds had none -- and a changelevel can hand a
  // server's first walk the map it is leaving. de_cache was stored with
  // Mirage's places.
  it("stores the published extract, not what a server read off the map it was leaving", async () => {
    published.de_cache = callouts("AMain", "Highway");

    const result = await service().report(
      "de_cache",
      callouts("Jungle", "PalaceAlley"),
    );

    expect(result.stored).toBe(0);
    expect(await rows("de_cache")).toEqual([
      { name: "AMain", source: "cdn" },
      { name: "Highway", source: "cdn" },
    ]);
  });

  it("replaces a stale report on the next one once the extract can be read", async () => {
    await service().report("de_cache", callouts("Jungle", "PalaceAlley"));
    published.de_cache = callouts("AMain", "Highway");

    await service().report("de_cache", callouts("Jungle", "PalaceAlley"));

    expect(await rows("de_cache")).toEqual([
      { name: "AMain", source: "cdn" },
      { name: "Highway", source: "cdn" },
    ]);
  });

  it("still stores the report when the CDN does not answer", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as never;

    const result = await service().report("de_cache", callouts("AMain"));

    expect(result.stored).toBe(1);
    expect(await rows("de_cache")).toEqual([
      { name: "AMain", source: "plugin" },
    ]);
  });

  // Every map load reports, and a workshop map is never going to be in the
  // extract.
  it("asks the CDN about a map it lacks once, not on every map load", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    const callouts_ = service();

    await callouts_.report("de_thera", callouts("Mid"));
    await callouts_.report("de_thera", callouts("Mid"));
    expect(fetched).toEqual(["https://cdn.test/maps/de_thera.callouts.json"]);
    expect(await rows("de_thera")).toEqual([{ name: "Mid", source: "plugin" }]);

    published.de_thera = callouts("Middle");
    now.mockReturnValue(1_000_000 + 11 * 60 * 1000);
    await callouts_.report("de_thera", callouts("Mid"));

    expect(fetched).toHaveLength(2);
    expect(await rows("de_thera")).toEqual([{ name: "Middle", source: "cdn" }]);
  });

  // Two servers load the same map: one is still waiting on the CDN when the
  // other (or a build-change sync) writes the extract, then its own fetch fails
  // and it falls back to its report.
  it("never writes a report over an extract that landed while it asked the CDN", async () => {
    global.fetch = jest.fn(async () => {
      await seedCdn("de_cache", "AMain", "Highway");
      throw new Error("timed out");
    }) as never;

    const result = await service().report("de_cache", callouts("Jungle"));

    expect(result.stored).toBe(0);
    expect(await rows("de_cache")).toEqual([
      { name: "AMain", source: "cdn" },
      { name: "Highway", source: "cdn" },
    ]);
  });

  it("leaves the published extract alone", async () => {
    await seedCdn("de_mirage", "Window");

    const result = await service().report("de_mirage", callouts("Windw"));

    expect(result.stored).toBe(0);
    expect(await rows()).toEqual([{ name: "Window", source: "cdn" }]);
  });

  // A night variant is the same geometry as its parent, and a workshop map
  // arrives with a path in front of it.
  it("files every spelling of a map under one name", async () => {
    await service().report("DE_Inferno_night", callouts("Banana"));
    await service().report("workshop/123/de_thera", callouts("Mid"));

    expect(await rows("de_inferno")).toEqual([
      { name: "Banana", source: "plugin" },
    ]);
    expect(await rows("de_thera")).toEqual([{ name: "Mid", source: "plugin" }]);
  });

  // A place Valve deleted has to go, or it keeps naming throws after the area
  // it named stopped existing.
  it("drops a callout that is no longer in the map", async () => {
    await service().report("de_mirage", callouts("Window", "Ladder"));
    await service().report("de_mirage", callouts("Window"));

    expect(await rows()).toEqual([{ name: "Window", source: "plugin" }]);
  });

  // The extract wins wherever it exists, so a name it does not carry has to go
  // even when a practice server reported it first -- otherwise a map filled in
  // before the extract landed keeps its mis-read names for ever, mixed in with
  // the real ones, and `report` will never correct them.
  it("sweeps away plugin names the published extract does not carry", async () => {
    const callouts_ = service();
    await callouts_.report("de_mirage", callouts("Window", "Windw", "Ladderr"));

    const fetched = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ callouts: callouts("Window") }),
    } as never);

    try {
      await callouts_.sync("de_mirage");
    } finally {
      fetched.mockRestore();
    }

    expect(await rows()).toEqual([{ name: "Window", source: "cdn" }]);
  });

  it("refuses a report with no usable geometry", async () => {
    const result = await service().report("de_mirage", [
      { name: "Broken", boxes: [] },
      { name: "", boxes: [{ min: [0, 0, 0], max: [1, 1, 1] } as never] },
    ]);

    expect(result.stored).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("reads back the rows it wrote", async () => {
    const callouts_ = service();
    await callouts_.report("de_mirage", callouts("Window"));

    expect(await callouts_.forMap("de_mirage")).toEqual([
      { name: "Window", boxes: [{ min: [0, 0, 0], max: [100, 100, 100] }] },
    ]);
  });

  it("syncs the published callouts of community maps too", async () => {
    const callouts_ = service();
    const synced: Array<string> = [];
    jest.spyOn(callouts_, "sync").mockImplementation(async (map: string) => {
      synced.push(map);
      return 0;
    });
    const cdn = process.env.MAP_MESH_CDN;
    process.env.MAP_MESH_CDN = "https://mirror.test/maps/1";

    try {
      await callouts_.syncAll();
    } finally {
      if (cdn === undefined) {
        delete process.env.MAP_MESH_CDN;
      } else {
        process.env.MAP_MESH_CDN = cdn;
      }
    }

    expect(synced).toEqual(
      expect.arrayContaining(["de_debris", "de_mirage", "de_poseidon"]),
    );
  });
});
