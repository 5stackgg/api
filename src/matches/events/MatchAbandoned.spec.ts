jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import MatchAbandoned from "./MatchAbandoned";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new MatchAbandoned(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("MatchAbandoned", () => {
  it("inserts abandoned_matches record with steam_id", async () => {
    const { event, hasura } = createEvent({ steam_id: "76561198000000001" });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_abandoned_matches_one: {
        __args: {
          object: {
            steam_id: "76561198000000001",
          },
        },
        __typename: true,
      },
    });
  });
});
