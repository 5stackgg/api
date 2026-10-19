import MatchMapResetRoundEvent from "./MatchMapResetRoundEvent";

describe("MatchMapResetRoundEvent", () => {
  const calls: Array<string> = [];
  let mapStatus = "Live";
  const hasura = {
    query: jest.fn(async () => ({ match_maps_by_pk: { status: mapStatus } })),
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
    mapStatus = "Live";
  });

  it("puts the map back to the round before the server loads its backup", async () => {
    await process("5");

    expect(calls).toEqual(["reset map-1 5", "restore match-1 5"]);
  });

  // Throwing would leave the event unanswered, and the server would send it
  // again until round 14 is played and the reset goes through.
  it("answers a reset to a round the map no longer has without loading it", async () => {
    matchAssistant.resetMatchMapToRound.mockRejectedValueOnce(
      Object.assign(
        new Error("there is no round 14 on this map to go back to"),
        { code: "P0002" },
      ),
    );

    await expect(process("14")).resolves.toBeUndefined();
    expect(matchAssistant.restoreMatchRound).not.toHaveBeenCalled();
  });

  it("lets any other failure through so the server sends it again", async () => {
    matchAssistant.resetMatchMapToRound.mockRejectedValueOnce(
      new Error("connection terminated"),
    );

    await expect(process("5")).rejects.toThrow("connection terminated");
    expect(matchAssistant.restoreMatchRound).not.toHaveBeenCalled();
  });

  it.each(["Warmup", "Knife", "Scheduled", "Finished"])(
    "leaves a map that is %s alone",
    async (status) => {
      mapStatus = status;

      await process("5");

      expect(calls).toEqual([]);
    },
  );

  it("leaves a Rush map alone unless it is replayed from the start", async () => {
    matchType = "Rush";

    await process("5");
    expect(calls).toEqual([]);

    await process("0");
    expect(calls).toEqual(["reset map-1 0", "restore match-1 0"]);
  });
});
