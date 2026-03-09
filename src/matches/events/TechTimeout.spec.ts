jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import TechTimeout from "./TechTimeout";

function createEvent(data: Record<string, any>) {
  const hasura = {
    mutation: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue({}),
  };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
  const matchAssistant = {};
  const chat = {};
  const event = new TechTimeout(
    logger as any,
    hasura as any,
    matchAssistant as any,
    chat as any,
  );
  event.setData("match-1", data as any);
  return { event, hasura, logger, chat };
}

describe("TechTimeout", () => {
  it("updates match map timeout availability for both lineups", async () => {
    const { event, hasura } = createEvent({
      map_id: "map-1",
      lineup_1_timeouts_available: 2,
      lineup_2_timeouts_available: 1,
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: {
            id: "map-1",
          },
          _set: {
            lineup_1_timeouts_available: 2,
            lineup_2_timeouts_available: 1,
          },
        },
        __typename: true,
      },
    });
  });
});
