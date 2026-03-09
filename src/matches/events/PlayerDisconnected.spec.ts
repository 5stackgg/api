jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import PlayerDisconnected from "./PlayerDisconnected";

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
  const chat = {
    leaveLobbyViaGame: jest.fn().mockResolvedValue(undefined),
  };
  const event = new PlayerDisconnected(
    logger as any,
    hasura as any,
    matchAssistant as any,
    chat as any,
  );
  event.setData("match-1", data as any);
  return { event, hasura, logger, chat };
}

describe("PlayerDisconnected", () => {
  it("calls chat.leaveLobbyViaGame with matchId and steam_id", async () => {
    const { event, chat } = createEvent({
      steam_id: "76561198000000001",
    });

    await event.process();

    expect(chat.leaveLobbyViaGame).toHaveBeenCalledWith(
      "match-1",
      "76561198000000001",
    );
  });
});
