jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import FlashEvent from "./FlashEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new FlashEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("FlashEvent", () => {
  it("inserts flash with duration and team_flash flag", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 3,
      attacker_steam_id: BigInt("76561198000000001"),
      attacked_steam_id: BigInt("76561198000000002"),
      match_map_id: "map-1",
      duration: 2.5,
      team_flash: false,
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_player_flashes_one: {
        __args: {
          object: {
            time: new Date("2026-01-01T00:00:00Z"),
            match_id: "match-1",
            match_map_id: "map-1",
            round: 3,
            attacker_steam_id: BigInt("76561198000000001"),
            attacked_steam_id: BigInt("76561198000000002"),
            duration: 2.5,
            team_flash: false,
          },
        },
        __typename: true,
      },
    });
  });
});
