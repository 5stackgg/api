jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import KnifeSwitch from "./KnifeSwitch";

function createEvent(data?: any) {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
  };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = { knifeSwitch: jest.fn().mockResolvedValue(undefined) };
  const chat = {};
  const event = new KnifeSwitch(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura, matchAssistant };
}

describe("KnifeSwitch", () => {
  it("swaps lineup sides on current map", async () => {
    const { event, hasura } = createEvent();

    hasura.query.mockResolvedValue({
      matches_by_pk: {
        current_match_map_id: "map-1",
        match_maps: [
          { id: "map-1", lineup_1_side: "CT", lineup_2_side: "TERRORIST" },
          { id: "map-2", lineup_1_side: "TERRORIST", lineup_2_side: "CT" },
        ],
      },
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: {
            id: "map-1",
          },
          _set: {
            status: "Live",
            lineup_1_side: "TERRORIST",
            lineup_2_side: "CT",
          },
        },
        __typename: true,
      },
    });
  });

  it("calls matchAssistant.knifeSwitch after mutation", async () => {
    const { event, hasura, matchAssistant } = createEvent();

    hasura.query.mockResolvedValue({
      matches_by_pk: {
        current_match_map_id: "map-1",
        match_maps: [
          { id: "map-1", lineup_1_side: "CT", lineup_2_side: "TERRORIST" },
        ],
      },
    });

    await event.process();

    expect(matchAssistant.knifeSwitch).toHaveBeenCalledWith("match-1");
  });
});
