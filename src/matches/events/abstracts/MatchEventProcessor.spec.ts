import { Logger } from "@nestjs/common";
import MatchEventProcessor from "./MatchEventProcessor";
import PlayerConnected from "../PlayerConnected";
import PlayersConnected from "../PlayersConnected";
import MatchUpdatedLineupsEvent from "../MatchUpdatedLineupsEvent";

const MATCH_ID = "11111111-1111-1111-1111-111111111111";
const STEAM_ID = "76561198000000002";

describe("MatchEventProcessor player names", () => {
  type Processor = new (
    ...args: ConstructorParameters<typeof PlayerConnected>
  ) => MatchEventProcessor<unknown>;

  it.each<[string, Processor, unknown]>([
    [
      "player-connected",
      PlayerConnected,
      { steam_id: STEAM_ID, player_name: "renamed" },
    ],
    [
      "players-connected",
      PlayersConnected,
      {
        players: [
          {
            steam_id: STEAM_ID,
            player_name: "renamed",
            team: "CT",
            lineup_id: null,
          },
        ],
      },
    ],
    [
      "updateLineups",
      MatchUpdatedLineupsEvent,
      {
        lineups: {
          lineup_1: [{ steam_id: STEAM_ID, name: "renamed", captain: false }],
          lineup_2: [],
        },
      },
    ],
  ])(
    "%s only renames a player in this match's lineups",
    async (_, Processor, data) => {
      // players.name is shown everywhere, so a server may only refresh the
      // names of its own match's players
      const hasura = {
        query: jest.fn(async () => ({ matches_by_pk: null as unknown })),
        mutation: jest.fn(async () => ({})),
      };
      const matchAssistant = {
        getMatchLineups: jest.fn(async () => ({
          lineup_1_id: "lineup-1",
          lineup_2_id: "lineup-2",
          lineup_players: [] as unknown[],
          options: { type: "Competitive" },
        })),
      };
      const chat = { joinLobbyViaGame: jest.fn() };

      const processor = new Processor(
        new Logger("MatchEventProcessorTest"),
        hasura as any,
        matchAssistant as any,
        chat as any,
        {} as any,
      );
      processor.setData(MATCH_ID, data);

      await processor.process();

      const upsert = hasura.mutation.mock.calls
        .map(
          ([mutation]: any) =>
            mutation.insert_players_one ?? mutation.insert_players,
        )
        .find(Boolean);

      expect(upsert.__args.on_conflict).toEqual({
        constraint: "players_steam_id_key",
        update_columns: ["name"],
        where: {
          _or: [
            { name_registered: { _is_null: true } },
            { name_registered: { _eq: false } },
          ],
          player_lineup: {
            lineup: {
              match_id: { _eq: MATCH_ID },
            },
          },
        },
      });
    },
  );
});
