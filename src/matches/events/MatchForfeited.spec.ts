jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import MatchForfeited from "./MatchForfeited";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new MatchForfeited(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("MatchForfeited", () => {
  it("sets match status to Forfeit with winning_lineup_id", async () => {
    const { event, hasura } = createEvent({ winning_lineup_id: "lineup-1" });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      update_matches_by_pk: {
        __args: {
          pk_columns: { id: "match-1" },
          _set: {
            status: "Forfeit",
            winning_lineup_id: "lineup-1",
          },
        },
        __typename: true,
      },
    });
  });
});
