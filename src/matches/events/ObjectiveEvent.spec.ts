jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import ObjectiveEvent from "./ObjectiveEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new ObjectiveEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("ObjectiveEvent", () => {
  it("inserts objective with player_steam_id, type, and round", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 7,
      player_steam_id: BigInt("76561198000000001"),
      type: "BombPlanted",
      match_map_id: "map-1",
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_player_objectives_one: {
        __args: {
          object: {
            time: new Date("2026-01-01T00:00:00Z"),
            match_id: "match-1",
            match_map_id: "map-1",
            type: "BombPlanted",
            round: 7,
            player_steam_id: BigInt("76561198000000001"),
          },
        },
        __typename: true,
      },
    });
  });
});
