import { SteamGcService } from "./steam-gc.service";
import { MatchParty } from "./types/MatchParty";

// extractMatchInfo / extractParties are pure private statics; reach them
// directly rather than standing up the GC client.
const extractMatchInfo = (
  SteamGcService as unknown as {
    extractMatchInfo: (matches: unknown) => {
      demoUrl: string;
      mapName: string | null;
      matchStartTime: string | null;
      parties: MatchParty[] | null;
    } | null;
  }
).extractMatchInfo;

const findByRoster = (
  SteamGcService as unknown as {
    findByRoster: (
      matches: unknown[],
      expected: string[],
      requestedFor: string,
    ) => unknown;
  }
).findByRoster;

const extractParties = (
  SteamGcService as unknown as {
    extractParties: (roundStats?: unknown[]) => MatchParty[] | null;
  }
).extractParties;

// account id -> steam64
const steamId = (accountId: number) =>
  (BigInt(accountId) + 76561197960265728n).toString();

const groupsOf = (parties: MatchParty[] | null) => {
  const byKey = new Map<string, string[]>();
  for (const party of parties ?? []) {
    byKey.set(party.party_key, [
      ...(byKey.get(party.party_key) ?? []),
      party.steam_id,
    ]);
  }
  return byKey;
};

describe("SteamGcService.extractParties", () => {
  it("zips the index-aligned account_ids and party_ids", () => {
    const parties = extractParties([
      {
        reservation: {
          //          duo         duo    solo   solo    trio  trio  trio
          account_ids: [111, 222, 333, 444, 555, 666, 777],
          party_ids: [9, 9, 0, 0, 4, 4, 4],
        },
      },
    ]);

    const groups = groupsOf(parties);
    expect(groups.size).toBe(2);
    expect(groups.get("9").sort()).toEqual([steamId(111), steamId(222)].sort());
    expect(groups.get("4").sort()).toEqual(
      [steamId(555), steamId(666), steamId(777)].sort(),
    );
    // party_id 0 means "queued alone"
    expect(parties.map((p) => p.steam_id)).not.toContain(steamId(333));
  });

  it("drops a party of one", () => {
    const parties = extractParties([
      {
        reservation: {
          account_ids: [111, 222],
          party_ids: [7, 8],
        },
      },
    ]);
    expect(parties).toBeNull();
  });

  it("returns null when the GC gave no reservation", () => {
    expect(extractParties([{ map: "http://demo" }])).toBeNull();
    expect(extractParties([])).toBeNull();
    expect(extractParties(undefined)).toBeNull();
    expect(extractParties([{ reservation: {} }])).toBeNull();
  });

  it("uses the last entry that carries both halves of the pairing", () => {
    const parties = extractParties([
      { reservation: { account_ids: [111, 222] } },
      {
        reservation: {
          account_ids: [333, 444],
          party_ids: [5, 5],
        },
      },
      { map: "http://demo" },
    ]);
    expect(groupsOf(parties).get("5").sort()).toEqual(
      [steamId(333), steamId(444)].sort(),
    );
  });
});

describe("SteamGcService.extractMatchInfo", () => {
  it("carries parties alongside the demo url", () => {
    const resolved = extractMatchInfo([
      {
        matchtime: 1700000000,
        watchablematchinfo: { game_map: "de_dust2" },
        roundstatsall: [
          {
            map: "http://replay/demo.dem.bz2",
            reservation: {
              account_ids: [111, 222, 333],
              party_ids: [3, 3, 0],
            },
          },
        ],
      },
    ]);

    expect(resolved.demoUrl).toBe("http://replay/demo.dem.bz2");
    expect(resolved.mapName).toBe("de_dust2");
    expect(groupsOf(resolved.parties).get("3").sort()).toEqual(
      [steamId(111), steamId(222)].sort(),
    );
  });

  it("resolves the demo with parties null when there is no reservation", () => {
    const resolved = extractMatchInfo([
      {
        roundstats_legacy: { map: "http://replay/demo.dem.bz2" },
      },
    ]);
    expect(resolved.demoUrl).toBe("http://replay/demo.dem.bz2");
    expect(resolved.parties).toBeNull();
  });
});

// A manually uploaded demo has no Valve match id (external_id is its
// filename), so the match is identified by who played in it instead.
describe("SteamGcService.findByRoster", () => {
  const entry = (accountIds: number[], matchid = "1") => ({
    matchid,
    roundstatsall: [
      {
        reservation: {
          account_ids: accountIds,
          party_ids: accountIds.map(() => 0),
        },
      },
    ],
  });

  const TEN = [11, 22, 33, 44, 55, 66, 77, 88, 99, 100];
  const roster = TEN.map(steamId);

  it("finds the match whose roster matches", () => {
    const wanted = entry(TEN, "7777");
    const found = findByRoster(
      [entry([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "1111"), wanted],
      roster,
      steamId(11),
    );
    expect((found as { matchid: string })?.matchid).toBe("7777");
  });

  it("ignores a game the requested player was not in", () => {
    // same ten players, but we asked on behalf of someone absent
    expect(findByRoster([entry(TEN)], roster, steamId(999))).toBeUndefined();
  });

  it("refuses a weak overlap rather than guessing", () => {
    // only 3 of 10 shared - a different game with a few of the same players
    const overlapping = entry([11, 22, 33, 501, 502, 503, 504, 505, 506, 507]);
    expect(findByRoster([overlapping], roster, steamId(11))).toBeUndefined();
  });

  it("prefers the strongest overlap", () => {
    const partial = entry([11, 22, 33, 44, 55, 66, 77, 901, 902, 903], "weak");
    const exact = entry(TEN, "strong");
    const found = findByRoster([partial, exact], roster, steamId(11));
    expect((found as { matchid: string })?.matchid).toBe("strong");
  });

  it("does not fingerprint off a roster we barely know", () => {
    expect(
      findByRoster([entry(TEN)], [steamId(11)], steamId(11)),
    ).toBeUndefined();
  });
});
