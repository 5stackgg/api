jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import CaptainEvent from "./CaptainEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = { getMatchLineups: jest.fn() };
  const chat = {};
  const event = new CaptainEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura, matchAssistant };
}

describe("CaptainEvent", () => {
  it("finds player by steam_id and updates captain via steam_id key", async () => {
    const { event, hasura, matchAssistant } = createEvent({
      claim: true,
      steam_id: "76561198000000001",
      player_name: "PlayerOne",
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_players: [
        { steam_id: "76561198000000001", discord_id: "d1", player: null, placeholder_name: "" },
        { steam_id: "76561198000000002", discord_id: "d2", player: null, placeholder_name: "" },
      ],
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      update_match_lineup_players: {
        __args: {
          where: {
            steam_id: { _eq: "76561198000000001" },
          },
          _set: {
            captain: true,
          },
        },
        affected_rows: true,
      },
    });
  });

  it("finds player by player.name prefix and updates captain via discord_id key", async () => {
    const { event, hasura, matchAssistant } = createEvent({
      claim: false,
      steam_id: "76561198000000003",
      player_name: "Player",
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_players: [
        { steam_id: null, discord_id: "d5", player: { name: "PlayerThree" }, placeholder_name: "" },
      ],
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      update_match_lineup_players: {
        __args: {
          where: {
            discord_id: { _eq: "d5" },
          },
          _set: {
            captain: false,
          },
        },
        affected_rows: true,
      },
    });
  });

  it("finds player by placeholder_name prefix and updates captain via discord_id key", async () => {
    const { event, hasura, matchAssistant } = createEvent({
      claim: true,
      steam_id: "76561198000000004",
      player_name: "Place",
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_players: [
        { steam_id: null, discord_id: "d7", player: null, placeholder_name: "PlaceholderGuy" },
      ],
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      update_match_lineup_players: {
        __args: {
          where: {
            discord_id: { _eq: "d7" },
          },
          _set: {
            captain: true,
          },
        },
        affected_rows: true,
      },
    });
  });

  it("returns early when player not found in lineups", async () => {
    const { event, hasura, matchAssistant } = createEvent({
      claim: true,
      steam_id: "76561198000000099",
      player_name: "Nobody",
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_players: [
        { steam_id: "76561198000000001", discord_id: "d1", player: null, placeholder_name: "" },
      ],
    });

    await event.process();

    expect(hasura.mutation).not.toHaveBeenCalled();
  });
});
