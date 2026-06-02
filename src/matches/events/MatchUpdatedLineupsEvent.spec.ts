jest.mock("./abstracts/MatchEventProcessor", () => {
  return class MatchEventProcessor<T> {
    protected data: T;
    protected matchId: string;

    constructor(
      protected readonly logger: any,
      protected readonly hasura: any,
      protected readonly matchAssistant: any,
    ) {}

    public setData(matchId: string, data: T) {
      this.data = data;
      this.matchId = matchId.trim();
    }
  };
});

import MatchUpdatedLineupsEvent from "./MatchUpdatedLineupsEvent";

describe("MatchUpdatedLineupsEvent", () => {
  const buildProcessor = (existingSteamIds: string[]) => {
    const hasura = {
      mutation: jest.fn().mockResolvedValue({}),
    };
    const existingPlayers = existingSteamIds.map((steam_id) => ({ steam_id }));
    const matchAssistant = {
      getMatchLineups: jest.fn().mockResolvedValue({
        options: {
          type: "Competitive",
        },
        lineup_1_id: "lineup-1",
        lineup_2_id: "lineup-2",
        lineup_1: {
          lineup_players: existingPlayers.slice(0, 5),
        },
        lineup_2: {
          lineup_players: existingPlayers.slice(5),
        },
        lineup_players: existingPlayers,
      }),
    };

    const processor = new MatchUpdatedLineupsEvent(
      {} as any,
      hasura as any,
      matchAssistant as any,
      {} as any,
      {} as any,
    );

    return { processor, hasura, matchAssistant };
  };

  const lineups = {
    lineup_1: [
      { name: "Player 1", captain: true, steam_id: "1" },
      { name: "Player 2", captain: false, steam_id: "2" },
      { name: "Player 3", captain: false, steam_id: "3" },
      { name: "Player 4", captain: false, steam_id: "4" },
      { name: "Player 5", captain: false, steam_id: "5" },
    ],
    lineup_2: [
      { name: "Player 6", captain: true, steam_id: "6" },
      { name: "Player 7", captain: false, steam_id: "7" },
      { name: "Player 8", captain: false, steam_id: "8" },
      { name: "Player 9", captain: false, steam_id: "9" },
      { name: "Stand In", captain: false, steam_id: "10" },
    ],
  };

  it("processes a full competitive lineup update with a stand-in", async () => {
    const { processor, hasura } = buildProcessor([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);

    processor.setData("match-1", { lineups });

    await processor.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_match_lineup_players: expect.any(Object),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_match_lineup_players: {
        __args: {
          objects: [
            {
              discord_id: "Stand In",
              captain: false,
              steam_id: "10",
              match_lineup_id: "lineup-2",
            },
          ],
        },
        affected_rows: true,
      },
    });
  });

  it("processes partial lineup updates", async () => {
    const { processor, hasura } = buildProcessor(["1", "2", "3"]);

    processor.setData("match-1", {
      lineups: {
        lineup_1: lineups.lineup_1.slice(0, 2),
        lineup_2: [],
      },
    });

    await processor.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_match_lineup_players: expect.any(Object),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_match_lineup_players: {
        __args: {
          objects: [],
        },
        affected_rows: true,
      },
    });
  });
});
