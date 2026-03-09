jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import AssistEvent from "./AssistEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new AssistEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("AssistEvent", () => {
  it("inserts assist with correct fields", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 5,
      attacker_steam_id: BigInt("76561198000000001"),
      attacker_team: "CT",
      attacker_location: "MidDoors",
      attacked_steam_id: BigInt("76561198000000002"),
      attacked_team: "TERRORIST",
      flash: true,
      match_map_id: "map-1",
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_player_assists_one: {
        __args: {
          object: {
            time: new Date("2026-01-01T00:00:00Z"),
            match_map_id: "map-1",
            match_id: "match-1",
            round: 5,
            attacker_steam_id: BigInt("76561198000000001"),
            attacker_team: "CT",
            attacked_steam_id: BigInt("76561198000000002"),
            attacked_team: "TERRORIST",
            flash: true,
          },
        },
        __typename: true,
      },
    });
  });
});
