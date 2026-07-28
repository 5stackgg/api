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
