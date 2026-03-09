jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import PlayerConnected from "./PlayerConnected";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = { joinLobbyViaGame: jest.fn().mockResolvedValue(undefined) };
  const event = new PlayerConnected(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura, chat };
}

describe("PlayerConnected", () => {
  it("upserts player with on_conflict update name", async () => {
    const { event, hasura } = createEvent({
      steam_id: "76561198000000001",
      player_name: "TestPlayer",
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_players_one: {
        __args: {
          object: {
            name: "TestPlayer",
            steam_id: "76561198000000001",
          },
          on_conflict: {
            constraint: "players_steam_id_key",
            update_columns: ["name"],
          },
        },
        __typename: true,
      },
    });
  });

  it("joins chat lobby via game", async () => {
    const { event, chat } = createEvent({
      steam_id: "76561198000000001",
      player_name: "TestPlayer",
    });

    await event.process();

    expect(chat.joinLobbyViaGame).toHaveBeenCalledWith("match-1", "76561198000000001");
  });
});
