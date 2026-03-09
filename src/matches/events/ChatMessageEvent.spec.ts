jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

jest.mock("src/chat/enums/ChatLobbyTypes", () => ({
  ChatLobbyType: { Match: "Match" },
}));

import ChatMessageEvent from "./ChatMessageEvent";

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
    sendMessageToChat: jest.fn().mockResolvedValue(undefined),
  };
  const event = new ChatMessageEvent(
    logger as any,
    hasura as any,
    matchAssistant as any,
    chat as any,
  );
  event.setData("match-1", data as any);
  return { event, hasura, logger, chat };
}

describe("ChatMessageEvent", () => {
  it("queries player and sends chat message when player found", async () => {
    const player = {
      name: "TestPlayer",
      role: "user",
      steam_id: "76561198000000001",
      profile_url: "https://steamcommunity.com/id/test",
      avatar_url: "https://avatars.example.com/test.jpg",
      discord_id: "123456789",
    };

    const { event, hasura, chat } = createEvent({
      player: "76561198000000001",
      message: "Hello world",
    });

    hasura.query.mockResolvedValue({ players_by_pk: player });

    await event.process();

    expect(hasura.query).toHaveBeenCalledWith({
      players_by_pk: {
        __args: {
          steam_id: "76561198000000001",
        },
        name: true,
        role: true,
        steam_id: true,
        profile_url: true,
        avatar_url: true,
        discord_id: true,
      },
    });

    expect(chat.sendMessageToChat).toHaveBeenCalledWith(
      "Match",
      "match-1",
      player,
      "Hello world",
      true,
    );
  });

  it("logs warning and returns early when player not found", async () => {
    const { event, hasura, logger, chat } = createEvent({
      player: "76561198000000002",
      message: "Hello world",
    });

    hasura.query.mockResolvedValue({ players_by_pk: null });

    await event.process();

    expect(logger.warn).toHaveBeenCalledWith(
      "unable to find player",
      "76561198000000002",
    );

    expect(chat.sendMessageToChat).not.toHaveBeenCalled();
  });
});
