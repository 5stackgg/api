import MatchMapStatusEvent from "./MatchMapStatusEvent";

describe("MatchMapStatusEvent", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const hasura = { query: jest.fn(), mutation: jest.fn() };
  const matchAssistant = { sendServerMatchId: jest.fn() };
  const notifications = {
    sendMatchMapPauseNotification: jest.fn(),
    resolveMatchAlerts: jest.fn(),
  };

  let matchMaps: Array<{ id: string; status: string }>;
  let currentMatchMapId: string | null;

  const process = async (status: string, winningLineupId?: string) => {
    const event = new MatchMapStatusEvent(
      logger as any,
      hasura as any,
      matchAssistant as any,
      {} as any,
      notifications as any,
    );
    event.setData("match-1", {
      status: status as any,
      winning_lineup_id: winningLineupId,
    });
    await event.process();
  };

  const mapUpdates = () =>
    hasura.mutation.mock.calls
      .map(([mutation]: [any]) => mutation.update_match_maps_by_pk)
      .filter(Boolean);

  beforeEach(() => {
    jest.clearAllMocks();
    hasura.query.mockImplementation(async (query: any) => {
      if (query.match_map_rounds) {
        return {
          match_map_rounds: [{ lineup_1_score: 13, lineup_2_score: 7 }],
        };
      }
      return {
        matches_by_pk: {
          current_match_map_id: currentMatchMapId,
          lineup_1_id: "lineup-1",
          lineup_2_id: "lineup-2",
          status: "Live",
          match_maps: matchMaps,
        },
      };
    });
    hasura.mutation.mockResolvedValue({
      update_match_maps_by_pk: {
        id: "map",
        match: { current_match_map_id: "map-2" },
      },
    });
  });

  describe("a late end-of-map status after the map was already finished", () => {
    beforeEach(() => {
      matchMaps = [
        { id: "map-1", status: "Finished" },
        { id: "map-2", status: "Scheduled" },
      ];
      currentMatchMapId = "map-2";
    });

    it.each(["WaitingForTV", "UploadingDemo", "Finished"])(
      "does not write %s onto the next, unplayed map",
      async (status) => {
        await process(status, "lineup-1");

        expect(mapUpdates()).toEqual([]);
        expect(matchAssistant.sendServerMatchId).not.toHaveBeenCalled();
      },
    );
  });

  it("moves a live map into WaitingForTV", async () => {
    matchMaps = [{ id: "map-1", status: "Live" }];
    currentMatchMapId = "map-1";

    await process("WaitingForTV", "lineup-1");

    expect(mapUpdates()).toEqual([
      expect.objectContaining({
        __args: {
          pk_columns: { id: "map-1" },
          _set: { status: "WaitingForTV", winning_lineup_id: "lineup-1" },
        },
      }),
    ]);
  });

  it("finishes a map that is uploading its demo", async () => {
    matchMaps = [
      { id: "map-1", status: "UploadingDemo" },
      { id: "map-2", status: "Scheduled" },
    ];
    currentMatchMapId = "map-1";

    await process("Finished", "lineup-1");

    expect(mapUpdates()).toEqual([
      expect.objectContaining({
        __args: {
          pk_columns: { id: "map-1" },
          _set: { status: "Finished", winning_lineup_id: "lineup-1" },
        },
      }),
    ]);
    expect(matchAssistant.sendServerMatchId).toHaveBeenCalledWith("match-1");
  });

  it("still applies statuses that start a map", async () => {
    matchMaps = [{ id: "map-1", status: "Warmup" }];
    currentMatchMapId = "map-1";

    await process("Live");

    expect(mapUpdates()).toEqual([
      expect.objectContaining({
        __args: { pk_columns: { id: "map-1" }, _set: { status: "Live" } },
      }),
    ]);
  });
});
