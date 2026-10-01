import { ServerRosterService } from "./server-roster.service";
import { PruneServerPlayerSessions } from "./jobs/PruneServerPlayerSessions";

describe("ServerRosterService.rosterEntries", () => {
  const NYX = "76561198041234567";
  const MIKA = "76561197990771020";

  it("leaves the roster alone when the plugin does not send one", () => {
    expect(ServerRosterService.rosterEntries(undefined)).toBeNull();
    expect(ServerRosterService.rosterEntries(null)).toBeNull();
    expect(ServerRosterService.rosterEntries({})).toBeNull();
  });

  it("treats an empty list as an empty server", () => {
    expect(ServerRosterService.rosterEntries([])).toEqual([]);
  });

  it("keeps only string SteamID64s, once each", () => {
    expect(
      ServerRosterService.rosterEntries([
        { steam_id: NYX },
        { steam_id: NYX, name: "duplicate" },
        { steam_id: 76561198041234567 },
        { steam_id: "123" },
        { steam_id: "7656119804123456x" },
        null,
      ]),
    ).toEqual([
      { steam_id: NYX, conn: null, name: null, ip: null, kills: 0, deaths: 0 },
    ]);
  });

  it("caps a roster at the most players a server can hold", () => {
    const players = Array.from({ length: 80 }, (_, index) => ({
      steam_id: `765611980${String(index).padStart(8, "0")}`,
    }));

    expect(ServerRosterService.rosterEntries(players)).toHaveLength(64);
  });

  it("drops counters that are not small non-negative integers", () => {
    const [entry] = ServerRosterService.rosterEntries([
      { steam_id: NYX, kills: -1, deaths: 1.5 },
    ])!;
    expect(entry).toMatchObject({ kills: 0, deaths: 0 });

    const [counted] = ServerRosterService.rosterEntries([
      { steam_id: NYX, kills: 12, deaths: 9 },
    ])!;
    expect(counted).toMatchObject({ kills: 12, deaths: 9 });
  });

  it("keeps a connection id only when it is a short plain token", () => {
    const [entry, spaced, long] = ServerRosterService.rosterEntries([
      { steam_id: NYX, conn: "b1f4c0de-17" },
      { steam_id: MIKA, conn: "has spaces" },
      { steam_id: "76561198000000003", conn: "x".repeat(65) },
    ])!;

    expect(entry.conn).toBe("b1f4c0de-17");
    expect(spaced.conn).toBeNull();
    expect(long.conn).toBeNull();
  });

  // One entry per finished connection, and a player who rejoined between two
  // syncs is in both lists: the departed entry settles the old connection.
  it("keeps one departed entry per connection", () => {
    expect(
      ServerRosterService.departedEntries([
        { steam_id: NYX, conn: "a", kills: 3, deaths: 1 },
        { steam_id: NYX, conn: "a", kills: 9, deaths: 9 },
        { steam_id: NYX, conn: "b", kills: 2, deaths: 0 },
        { steam_id: MIKA, kills: 2, deaths: 4 },
        { steam_id: "bad", conn: "c" },
      ]),
    ).toEqual([
      { steam_id: NYX, conn: "a", kills: 3, deaths: 1 },
      { steam_id: NYX, conn: "b", kills: 2, deaths: 0 },
    ]);
  });
});

describe("ServerRosterService.playerName", () => {
  it("strips control and direction-changing characters", () => {
    expect(ServerRosterService.playerName("ny\u0000x‮​")).toBe("nyx");
  });

  // JSON.stringify keeps a lone surrogate, which jsonb then rejects, failing
  // the whole server's sync.
  it("strips lone surrogates", () => {
    expect(ServerRosterService.playerName("ny\ud800x")).toBe("nyx");
  });

  it("collapses whitespace and trims", () => {
    expect(ServerRosterService.playerName("  nyx \n | \t 5stack ")).toBe(
      "nyx | 5stack",
    );
  });

  it("keeps at most 64 characters, counting emoji as one", () => {
    const name = ServerRosterService.playerName("🔥".repeat(80));
    expect(Array.from(name!)).toHaveLength(64);
  });

  it("returns null for nothing printable", () => {
    expect(ServerRosterService.playerName("​ \u0007")).toBeNull();
    expect(ServerRosterService.playerName(42)).toBeNull();
  });
});

describe("ServerRosterService.ip", () => {
  it.each([
    ["203.0.113.24:27005", "203.0.113.24"],
    ["203.0.113.24", "203.0.113.24"],
    ["[2001:db8::1]:27005", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["loopback", null],
    ["", null],
    ["999.1.1.1:27005", null],
    ["fe80::1%eth0", null],
    ["[fe80::1%eth0]:27005", null],
  ])("parses %s", (value, expected) => {
    expect(ServerRosterService.ip(value)).toBe(expected);
  });
});

describe("ServerRosterService.apply", () => {
  it("never touches the database for a plugin that predates rosters", async () => {
    const query = jest.fn();
    const service = new ServerRosterService(
      { warn: jest.fn() } as never,
      { query } as never,
      { getConnection: () => ({}) } as never,
    );

    await expect(
      service.apply("11111111-1111-1111-1111-111111111111", undefined, []),
    ).resolves.toBe(false);

    expect(query).not.toHaveBeenCalled();
  });

  it("only keeps a held roster fresh, without syncing sessions", async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ServerRosterService(
      { warn: jest.fn() } as never,
      { query } as never,
      { getConnection: () => ({}) } as never,
    );

    await expect(
      service.apply("11111111-1111-1111-1111-111111111111", null, [
        { steam_id: "76561198041234567", conn: "a", kills: 1, deaths: 0 },
      ]),
    ).resolves.toBe(false);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/UPDATE public\.server_rosters/);
    expect(query.mock.calls[0][0]).not.toMatch(/sync_server_player_sessions/);
  });

  // The plugin keeps its departures until a sync says they were recorded.
  it("reports a database failure as not recorded, so sanctions still sync", async () => {
    const warn = jest.fn();
    const service = new ServerRosterService(
      { warn } as never,
      { query: jest.fn().mockRejectedValue(new Error("deadlock")) } as never,
      { getConnection: () => ({}) } as never,
    );

    await expect(
      service.apply(
        "11111111-1111-1111-1111-111111111111",
        [{ steam_id: "76561198041234567" }],
        [],
      ),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("PruneServerPlayerSessions.clampRetentionDays", () => {
  it.each([
    [undefined, 7],
    ["abc", 7],
    ["3", 7],
    ["14", 14],
    ["400", 90],
  ])("turns %s into %i days", (value, expected) => {
    expect(PruneServerPlayerSessions.clampRetentionDays(value)).toBe(expected);
  });
});
