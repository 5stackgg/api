import MatchMapResetRoundEvent from "./MatchMapResetRoundEvent";

describe("MatchMapResetRoundEvent", () => {
  const calls: Array<string> = [];
  const hasura = {
    query: jest.fn(async () => ({ match_maps_by_pk: { status: "Live" } })),
  };
  let matchType = "Competitive";
  const matchAssistant = {
    getMatchType: jest.fn(async () => matchType),
    resetMatchMapToRound: jest.fn(async (mapId: string, round: number) => {
      calls.push(`reset ${mapId} ${round}`);
    }),
    restoreMatchRound: jest.fn(async (matchId: string, round: number) => {
      calls.push(`restore ${matchId} ${round}`);
    }),
  };

  const process = async (round: string) => {
    const event = new MatchMapResetRoundEvent(
      { log: jest.fn(), warn: jest.fn() } as never,
      hasura as never,
      matchAssistant as never,
      {} as never,
      {} as never,
    );
    event.setData("match-1", { round, match_map_id: "map-1" });
    await event.process();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    matchType = "Competitive";
  });

  it("puts the map back to the round before the server loads its backup", async () => {
    await process("5");

    expect(calls).toEqual(["reset map-1 5", "restore match-1 5"]);
  });

  it("leaves a Rush map alone unless it is replayed from the start", async () => {
    matchType = "Rush";

    await process("5");
    expect(calls).toEqual([]);

    await process("0");
    expect(calls).toEqual(["reset map-1 0", "restore match-1 0"]);
  });
});
