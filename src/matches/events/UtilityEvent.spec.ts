jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import UtilityEvent from "./UtilityEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new UtilityEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("UtilityEvent", () => {
  it("inserts utility with type and attacker coordinates", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 4,
      attacker_steam_id: BigInt("76561198000000001"),
      location: "BombsiteA",
      type: "Smoke",
      match_map_id: "map-1",
      attacker_location_coordinates: "1234.5 678.9 100.0",
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_player_utility_one: {
        __args: {
          object: {
            time: new Date("2026-01-01T00:00:00Z"),
            match_id: "match-1",
            match_map_id: "map-1",
            round: 4,
            type: "Smoke",
            attacker_steam_id: BigInt("76561198000000001"),
            attacker_location_coordinates: "1234.5 678.9 100.0",
          },
        },
        __typename: true,
      },
    });
  });
});
