import { SteamGcService } from "./steam-gc.service";
import { SteamPresenceService } from "../steam-presence/steam-presence.service";

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

describe("SteamGcService logon", () => {
  const ACCOUNT = "gc-bot";

  const gcLogOn = async (refreshToken: string | null) => {
    const service = new SteamGcService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      {
        get: jest.fn((key: string) =>
          key === "steam.steamUser" ? ACCOUNT : "hunter2",
        ),
      } as never,
      { get: jest.fn(async () => refreshToken), put: jest.fn() } as never,
    );
    const client = { logOn: jest.fn() };

    await service["logOn"](client as never);

    return client.logOn.mock.calls[0][0];
  };

  const presenceLogOn = async (refreshToken: string) => {
    const service = new SteamPresenceService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      { get: jest.fn(() => ({})) } as never,
      { get: jest.fn(async () => refreshToken), put: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const account = { id: "friends-1", username: ACCOUNT, password: "x" };
    const client = { logOn: jest.fn() };
    service["clients"].set(account.id, client as never);

    await service["logOn"](client as never, account);

    return client.logOn.mock.calls[0][0];
  };

  it("logs in with its own logon id from the stored refresh token", async () => {
    const details = await gcLogOn("refresh-token");

    expect(details.refreshToken).toBe("refresh-token");
    expect(details.logonID).toBeGreaterThan(0);
    expect(details.logonID).toBeLessThanOrEqual(2 ** 32 - 1);
  });

  it("logs in with the same logon id from STEAM_USER credentials", async () => {
    const fromToken = await gcLogOn("refresh-token");
    const details = await gcLogOn(null);

    expect(details).toMatchObject({
      accountName: ACCOUNT,
      password: "hunter2",
    });
    expect(details.logonID).toBeGreaterThan(0);
    expect(details.logonID).toBe(fromToken.logonID);
  });

  it("never shares a logon id with Steam Presence on the same account", async () => {
    const gc = await gcLogOn("refresh-token");
    const presence = await presenceLogOn("refresh-token");

    expect(presence).toEqual({ refreshToken: "refresh-token" });
    expect(gc.logonID ?? 0).not.toBe(presence.logonID ?? 0);
  });
});
