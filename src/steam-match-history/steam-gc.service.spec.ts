import { SteamGcService } from "./steam-gc.service";

// extractMatchInfo is a pure private static; reach it directly rather than
// standing up the GC client.
const extractMatchInfo = (
  SteamGcService as unknown as {
    extractMatchInfo: (matches: unknown) => {
      demoUrl: string | null;
      mapName: string | null;
      matchStartTime: string | null;
    } | null;
  }
).extractMatchInfo;

describe("SteamGcService.extractMatchInfo", () => {
  it("reads the demo url and map from roundstatsall", () => {
    const resolved = extractMatchInfo([
      {
        matchtime: 1700000000,
        watchablematchinfo: { game_map: "de_dust2" },
        roundstatsall: [{ map: "http://replay/demo.dem.bz2" }],
      },
    ]);

    expect(resolved.demoUrl).toBe("http://replay/demo.dem.bz2");
    expect(resolved.mapName).toBe("de_dust2");
    expect(resolved.matchStartTime).toBe(
      new Date(1700000000 * 1000).toISOString(),
    );
  });

  it("prefers the legacy round stats url when present", () => {
    const resolved = extractMatchInfo([
      {
        roundstats_legacy: { map: "http://replay/demo.dem.bz2" },
      },
    ]);
    expect(resolved.demoUrl).toBe("http://replay/demo.dem.bz2");
  });

  // The demo link expires long before the rest of the match info does, so a
  // missing url must not throw away the map/time we did get.
  it("still resolves when the demo url is missing", () => {
    const resolved = extractMatchInfo([
      {
        watchablematchinfo: { game_mapgroup: "mg_de_inferno" },
        roundstatsall: [{}],
      },
    ]);

    expect(resolved.demoUrl).toBeNull();
    expect(resolved.mapName).toBe("de_inferno");
  });

  it("returns null when the gc gave us nothing at all", () => {
    expect(extractMatchInfo([])).toBeNull();
    expect(extractMatchInfo(null)).toBeNull();
  });
});
