import { UtilityCalloutsService } from "./utility-callouts.service";

const box = (
  min: [number, number, number],
  max: [number, number, number],
) => ({ min, max });

describe("UtilityCalloutsService.calloutAt", () => {
  const callouts = [
    { name: "BombsiteA", boxes: [box([0, 0, 0], [1000, 1000, 200])] },
    { name: "Goose", boxes: [box([100, 100, 0], [300, 300, 200])] },
    { name: "Ramp", boxes: [box([2000, 0, 0], [2400, 400, 200])] },
  ];

  it("names the place a point is standing in", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 800, y: 800, z: 50 }, callouts),
    ).toBe("BombsiteA");
  });

  // The specific name is the one a player would say.
  it("prefers the smaller of two nested volumes", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 200, y: 200, z: 50 }, callouts),
    ).toBe("Goose");
  });

  it("names the place beneath a point resting above it", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 800, y: 800, z: 900 }, callouts),
    ).toBe("BombsiteA");
  });

  // Two places at the same XY on different levels is the Nuke/Vertigo case.
  it("uses Z to separate stacked places", () => {
    const stacked = [
      { name: "Upper", boxes: [box([0, 0, 100], [500, 500, 300])] },
      { name: "Lower", boxes: [box([0, 0, -400], [500, 500, -100])] },
    ];

    expect(
      UtilityCalloutsService.calloutAt({ x: 250, y: 250, z: 200 }, stacked),
    ).toBe("Upper");
    expect(
      UtilityCalloutsService.calloutAt({ x: 250, y: 250, z: -200 }, stacked),
    ).toBe("Lower");
  });

  it("snaps to a nearby place when the point is outside every volume", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 1100, y: 500, z: 50 }, callouts),
    ).toBe("BombsiteA");
  });

  it("says nothing when the nearest place is too far to mean anything", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 9000, y: 9000, z: 50 }, callouts),
    ).toBeNull();
  });

  it("says nothing when the map has no callouts", () => {
    expect(UtilityCalloutsService.calloutAt({ x: 0, y: 0, z: 0 }, [])).toBeNull();
  });
});

describe("UtilityCalloutsService.humanize", () => {
  it.each([
    ["BombsiteA", "A Site"],
    ["BombsiteB", "B Site"],
    ["TSpawn", "T Spawn"],
    ["CTSpawn", "CT Spawn"],
    ["Catwalk", "Catwalk"],
    ["LongDoors", "Long Doors"],
    ["back_alley", "back alley"],
  ])("%s reads as %s", (raw, expected) => {
    expect(UtilityCalloutsService.humanize(raw)).toBe(expected);
  });
});

describe("UtilityCalloutsService.normalizeMapName", () => {
  it.each([
    ["de_mirage", "de_mirage"],
    ["DE_Mirage", "de_mirage"],
    ["de_inferno_night", "de_inferno"],
    ["workshop/3121217565/de_thera", "de_thera"],
  ])("%s normalises to %s", (raw, expected) => {
    expect(UtilityCalloutsService.normalizeMapName(raw)).toBe(expected);
  });
});

describe("auto naming", () => {
  const callouts = [
    { name: "TSpawn", boxes: [box([0, 0, 0], [500, 500, 200])] },
    { name: "Middle", boxes: [box([2000, 0, 0], [2500, 500, 200])] },
  ];

  const service = new UtilityCalloutsService(null as never, null as never);

  beforeEach(() => {
    jest.spyOn(service, "forMap").mockResolvedValue(callouts);
  });

  it("says where it lands and where it is thrown from", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "Smoke",
        { x: 250, y: 250, z: 50 },
        { x: 2250, y: 250, z: 50 },
      ),
    ).resolves.toBe("Middle Smoke from T Spawn");
  });

  it("does not repeat itself when both ends are the same place", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "Flash",
        { x: 100, y: 100, z: 50 },
        { x: 300, y: 300, z: 50 },
      ),
    ).resolves.toBe("T Spawn Flash");
  });

  it("uses the type label the panel uses", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "HighExplosive",
        { x: 250, y: 250, z: 50 },
        { x: 2250, y: 250, z: 50 },
      ),
    ).resolves.toBe("Middle HE from T Spawn");
  });

  // Empty rather than a name that says nothing, so the caller's own fallback
  // is still in play.
  it("says nothing when neither end is in a known place", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "Smoke",
        { x: 90000, y: 90000, z: 50 },
        { x: 95000, y: 95000, z: 50 },
      ),
    ).resolves.toBe("");
  });
});

describe("UtilityCalloutsService.calloutsUrl", () => {
  const originalCdn = process.env.MAP_MESH_CDN;
  const originalFetch = global.fetch;

  const pointer = {
    version: 1,
    build: "25537370",
    manifest: "25537370/manifest.json",
  };
  const manifest = {
    version: 1,
    build: "25537370",
    maps: {
      de_mirage: { callouts: "25000000/de_mirage.callouts.json" },
      de_nuke: { callouts: "25537370/de_nuke.callouts.json" },
      de_vertigo: { tri: "25537370/de_vertigo.tri.gz" },
    },
  };

  const respond = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  let files: Record<string, { body?: unknown; status: number }>;
  let fetchMock: jest.Mock;
  let service: UtilityCalloutsService;

  const fetched = (key: string) =>
    fetchMock.mock.calls.filter(
      ([url]) => url === `https://demo-dl.5stack.gg/maps/${key}`,
    ).length;

  beforeEach(() => {
    delete process.env.MAP_MESH_CDN;
    files = {
      "latest.json": { body: pointer, status: 200 },
      "25537370/manifest.json": { body: manifest, status: 200 },
    };
    fetchMock = jest.fn(async (url: string) => {
      const key = url.replace("https://demo-dl.5stack.gg/maps/", "");
      const file = files[key] ?? { status: 404 };
      return respond(file.body, file.status);
    });
    global.fetch = fetchMock as any;
    service = new UtilityCalloutsService(
      { warn: jest.fn() } as never,
      null as never,
    );
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

  it("keeps MAP_MESH_CDN as a flat directory", async () => {
    process.env.MAP_MESH_CDN = "https://mirror.test/maps/1";

    await expect(service.calloutsUrl("de_mirage")).resolves.toBe(
      "https://mirror.test/maps/1/de_mirage.callouts.json",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the key the latest manifest names, deduped into an older build", async () => {
    await expect(service.calloutsUrl("de_mirage")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/25000000/de_mirage.callouts.json",
    );
    await expect(service.calloutsUrl("de_nuke")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/25537370/de_nuke.callouts.json",
    );
    expect(fetched("latest.json")).toBe(1);
    expect(fetched("25537370/manifest.json")).toBe(1);
  });

  it("falls back to the pinned build for a map the manifest does not list", async () => {
    await expect(service.calloutsUrl("de_unknown")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/24957633/de_unknown.callouts.json",
    );
  });

  it("falls back per asset when the map's entry has no callouts", async () => {
    await expect(service.calloutsUrl("de_vertigo")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/24957633/de_vertigo.callouts.json",
    );
  });

  it("follows the manifest revision latest.json names", async () => {
    files["latest.json"] = {
      body: { ...pointer, manifest: "25537370/manifest.r2.json" },
      status: 200,
    };
    files["25537370/manifest.r2.json"] = {
      body: {
        ...manifest,
        maps: { de_anubis: { callouts: "25537370/de_anubis.callouts.json" } },
      },
      status: 200,
    };

    await expect(service.calloutsUrl("de_anubis")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/25537370/de_anubis.callouts.json",
    );
    expect(fetched("25537370/manifest.json")).toBe(0);
  });

  it.each([
    ["latest.json", { ...pointer, version: 2 }],
    ["25537370/manifest.json", { ...manifest, version: 2 }],
  ])("treats an unknown %s version like an outage", async (key, body) => {
    files[key] = { body, status: 200 };

    await expect(service.calloutsUrl("de_nuke")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/24957633/de_nuke.callouts.json",
    );
  });

  it("falls back to the pinned build when latest.json is unreachable", async () => {
    files["latest.json"] = { status: 502 };

    await expect(service.calloutsUrl("de_mirage")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/24957633/de_mirage.callouts.json",
    );
    await service.calloutsUrl("de_nuke");
    expect(fetched("latest.json")).toBe(1);
  });

  it("keeps the last manifest through a failed refresh", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    await service.calloutsUrl("de_nuke");

    files["latest.json"] = { status: 502 };
    now.mockReturnValue(1_000_000 + 11 * 60 * 1000);

    await expect(service.calloutsUrl("de_nuke")).resolves.toBe(
      "https://demo-dl.5stack.gg/maps/25537370/de_nuke.callouts.json",
    );
    expect(fetched("latest.json")).toBe(2);
  });

  it("has published a build latest.json has caught up with", async () => {
    await expect(service.hasPublished(25537370)).resolves.toBe(true);
    await expect(service.hasPublished(25400000)).resolves.toBe(true);
    await expect(service.hasPublished(25600000)).resolves.toBe(false);
    expect(fetched("latest.json")).toBe(3);
  });

  it("has published nothing while latest.json is unreachable", async () => {
    files["latest.json"] = { status: 502 };

    await expect(service.hasPublished(25537370)).resolves.toBe(false);
  });

  it("never waits on a MAP_MESH_CDN mirror", async () => {
    process.env.MAP_MESH_CDN = "https://mirror.test/maps/1";

    await expect(service.hasPublished(25600000)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-reads latest.json for a full sync", async () => {
    (service as any).postgres = { query: jest.fn().mockResolvedValue([]) };
    (service as any).logger = { warn: jest.fn(), log: jest.fn() };

    await service.calloutsUrl("de_nuke");
    await service.syncAll();

    expect(fetched("latest.json")).toBe(2);
  });

  it("syncs from the resolved URL", async () => {
    files["25000000/de_mirage.callouts.json"] = {
      body: {
        callouts: [{ name: "Palace", boxes: [box([0, 0, 0], [10, 10, 10])] }],
      },
      status: 200,
    };
    const write = jest
      .spyOn(service as any, "write")
      .mockResolvedValue(undefined);

    await expect(service.sync("de_mirage_night")).resolves.toBe(1);
    expect(write).toHaveBeenCalledWith(
      "de_mirage",
      [{ name: "Palace", boxes: [box([0, 0, 0], [10, 10, 10])] }],
      "cdn",
    );
  });
});
