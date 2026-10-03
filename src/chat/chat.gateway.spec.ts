import { ChatGateway } from "./chat.gateway";
import { ChatService } from "./chat.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

describe("ChatGateway lobby:chat", () => {
  let chat: { sendMessageToChat: jest.Mock; sendChatToServer: jest.Mock };
  let gateway: ChatGateway;

  const client = (user: any = { steam_id: "1", name: "Luke", role: "user" }) =>
    ({ id: "client-1", user, send: jest.fn() }) as any;

  const sent = (socket: { send: jest.Mock }) =>
    socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

  beforeEach(() => {
    chat = {
      sendMessageToChat: jest
        .fn()
        .mockResolvedValue({ accepted: true, messageId: "msg-1" }),
      sendChatToServer: jest.fn(),
    };
    gateway = new ChatGateway(chat as any);
  });

  describe("input", () => {
    it("ignores a socket that has not signed in", async () => {
      const socket = client(null);

      await gateway.lobby(
        { id: "m-1", type: ChatLobbyType.Match, message: "hi" },
        socket,
      );

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
      expect(chat.sendChatToServer).not.toHaveBeenCalled();
    });

    it.each([
      ["a number", 5],
      ["an object", { toString: "x" }],
      ["an array", ["hi"]],
      ["null", null],
      ["missing", undefined],
      ["only whitespace", "   \n  "],
    ])("ignores a message that is %s", async (_, message) => {
      const socket = client();

      await expect(
        gateway.lobby(
          { id: "m-1", type: ChatLobbyType.Match, message },
          socket,
        ),
      ).resolves.toBeUndefined();

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
    });

    it("ignores a lobby type it does not know", async () => {
      await gateway.lobby(
        { id: "m-1", type: "global" as ChatLobbyType, message: "hi" },
        client(),
      );

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
    });

    it("ignores a room id that is not a string", async () => {
      await gateway.lobby(
        { id: { $ne: 1 } as any, type: ChatLobbyType.Match, message: "hi" },
        client(),
      );

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
    });

    it("ignores a missing payload", async () => {
      await expect(
        gateway.lobby(undefined as any, client()),
      ).resolves.toBeUndefined();

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
    });

    it("sends the trimmed text", async () => {
      await gateway.lobby(
        { id: "t-1", type: ChatLobbyType.Tournament, message: "  hello  " },
        client(),
      );

      expect(chat.sendMessageToChat).toHaveBeenCalledWith(
        ChatLobbyType.Tournament,
        "t-1",
        expect.objectContaining({ steam_id: "1" }),
        "hello",
        false,
        "web",
        undefined,
      );
    });

    it("sends attachments that came without any text", async () => {
      await gateway.lobby(
        {
          id: "lobby-1",
          type: ChatLobbyType.MatchMaking,
          message: "",
          attachments: ["a-1", "a-2"],
        },
        client(),
      );

      expect(chat.sendMessageToChat).toHaveBeenCalledWith(
        ChatLobbyType.MatchMaking,
        "lobby-1",
        expect.objectContaining({ steam_id: "1" }),
        "",
        false,
        "web",
        { attachments: ["a-1", "a-2"], gif: undefined },
      );
    });

    it("sends a GIF that came without any text", async () => {
      const gif = { id: "abc123", width: 480, height: 270 };

      await gateway.lobby(
        { id: "lobby-1", type: ChatLobbyType.MatchMaking, gif } as any,
        client(),
      );

      expect(chat.sendMessageToChat).toHaveBeenCalledWith(
        ChatLobbyType.MatchMaking,
        "lobby-1",
        expect.objectContaining({ steam_id: "1" }),
        "",
        false,
        "web",
        { attachments: undefined, gif },
      );
    });

    it("tells the sender a captioned upload is too long", async () => {
      const socket = client();

      await gateway.lobby(
        {
          id: "lobby-1",
          type: ChatLobbyType.MatchMaking,
          message: "a".repeat(ChatService.MAX_MESSAGE_LENGTH + 1),
          attachments: ["a-1"],
          requestId: "r-9",
        },
        socket,
      );

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
      expect(sent(socket)).toEqual([
        {
          event: "chat:error",
          data: {
            code: ChatErrorCode.TooLong,
            action: "send",
            max: ChatService.MAX_MESSAGE_LENGTH,
            requestId: "r-9",
          },
        },
      ]);
    });
  });

  describe("length", () => {
    it("tells the sender a message is too long and never sends it", async () => {
      const socket = client();

      await gateway.lobby(
        {
          id: "m-1",
          type: ChatLobbyType.Match,
          message: "a".repeat(ChatService.MAX_MESSAGE_LENGTH + 1),
          requestId: "r-1",
        },
        socket,
      );

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
      expect(chat.sendChatToServer).not.toHaveBeenCalled();
      expect(sent(socket)).toEqual([
        {
          event: "chat:error",
          data: {
            code: ChatErrorCode.TooLong,
            action: "send",
            max: 2000,
            requestId: "r-1",
          },
        },
      ]);
    });

    it("leaves requestId out when the client sent none", async () => {
      const socket = client();

      await gateway.lobby(
        {
          id: "m-1",
          type: ChatLobbyType.Match,
          message: "a".repeat(ChatService.MAX_MESSAGE_LENGTH + 1),
        },
        socket,
      );

      expect(sent(socket)).toEqual([
        {
          event: "chat:error",
          data: { code: "too_long", action: "send", max: 2000 },
        },
      ]);
    });

    it("accepts exactly the limit", async () => {
      const message = "a".repeat(ChatService.MAX_MESSAGE_LENGTH);

      await gateway.lobby(
        { id: "m-1", type: ChatLobbyType.Match, message },
        client(),
      );

      expect(chat.sendMessageToChat).toHaveBeenCalledWith(
        ChatLobbyType.Match,
        "m-1",
        expect.anything(),
        message,
        false,
        "web",
        undefined,
      );
    });
  });

  describe("relaying to the game server", () => {
    it("never relays a send the room refused", async () => {
      // The relay has no membership check of its own: this is the only thing
      // stopping any signed-in socket printing into any live match.
      chat.sendMessageToChat.mockResolvedValue({
        accepted: false,
        code: ChatErrorCode.NotAllowed,
      });
      const socket = client();

      await gateway.lobby(
        {
          id: "someone-elses-match",
          type: ChatLobbyType.Match,
          message: "gg",
          requestId: "r-2",
        },
        socket,
      );

      expect(chat.sendChatToServer).not.toHaveBeenCalled();
      expect(sent(socket)).toEqual([
        {
          event: "chat:error",
          data: {
            code: ChatErrorCode.NotAllowed,
            action: "send",
            requestId: "r-2",
          },
        },
      ]);
    });

    it("tells a gagged sender why, and never relays them", async () => {
      chat.sendMessageToChat.mockResolvedValue({
        accepted: false,
        code: ChatErrorCode.Gagged,
      });
      const socket = client();

      await gateway.lobby(
        {
          id: "m-1",
          type: ChatLobbyType.Match,
          message: "gg",
          requestId: "r-4",
        },
        socket,
      );

      expect(chat.sendChatToServer).not.toHaveBeenCalled();
      expect(sent(socket)).toEqual([
        {
          event: "chat:error",
          data: { code: "gagged", action: "send", requestId: "r-4" },
        },
      ]);
    });

    it("says nothing about a refusal that carries no code", async () => {
      chat.sendMessageToChat.mockResolvedValue({ accepted: false });
      const socket = client();

      await gateway.lobby(
        { id: "m-1", type: ChatLobbyType.Match, message: "gg" },
        socket,
      );

      expect(chat.sendChatToServer).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
    });

    it("relays an accepted match message", async () => {
      await gateway.lobby(
        { id: "m-1", type: ChatLobbyType.Match, message: 'say "gg"' },
        client(),
      );

      expect(chat.sendChatToServer).toHaveBeenCalledWith(
        "m-1",
        "Luke: say 'gg'",
        false,
      );
    });

    it("marks an organizer's relayed message, by flag and by tag", async () => {
      await gateway.lobby(
        { id: "m-1", type: ChatLobbyType.Match, message: "pause please" },
        client({ steam_id: "1", name: "Luke", role: "administrator" }),
      );

      expect(chat.sendChatToServer).toHaveBeenCalledWith(
        "m-1",
        "[organizer] Luke: pause please",
        true,
      );
    });

    it("never flags a player who named themselves [organizer]", async () => {
      await gateway.lobby(
        { id: "m-1", type: ChatLobbyType.Match, message: "pause please" },
        client({ steam_id: "1", name: "[organizer] Mallory", role: "user" }),
      );

      expect(chat.sendChatToServer).toHaveBeenCalledWith(
        "m-1",
        "[organizer] Mallory: pause please",
        false,
      );
    });

    it("never relays a team room", async () => {
      await gateway.lobby(
        { id: "m-1:l-1", type: ChatLobbyType.MatchTeam, message: "rush b" },
        client(),
      );

      expect(chat.sendMessageToChat).toHaveBeenCalled();
      expect(chat.sendChatToServer).not.toHaveBeenCalled();
    });

    it.each([
      ChatLobbyType.Direct,
      ChatLobbyType.Tournament,
      ChatLobbyType.Draft,
      ChatLobbyType.MatchMaking,
      ChatLobbyType.Organizer,
    ])("never relays a %s room", async (type) => {
      await gateway.lobby({ id: "x", type, message: "hi" }, client());

      expect(chat.sendChatToServer).not.toHaveBeenCalled();
    });
  });

  describe("acknowledgement", () => {
    it("acks an accepted send that carried a requestId", async () => {
      const socket = client();

      await gateway.lobby(
        {
          id: "t-1",
          type: ChatLobbyType.Tournament,
          message: "hi",
          requestId: "r-3",
        },
        socket,
      );

      expect(sent(socket)).toEqual([
        {
          event: "chat:ack",
          data: { requestId: "r-3", messageId: "msg-1", action: "send" },
        },
      ]);
    });

    it("stays quiet for an accepted send without one", async () => {
      const socket = client();

      await gateway.lobby(
        { id: "t-1", type: ChatLobbyType.Tournament, message: "hi" },
        socket,
      );

      expect(socket.send).not.toHaveBeenCalled();
    });
  });
});

describe("ChatGateway lobby:delete", () => {
  const MESSAGE_ID = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

  let chat: { deleteMessage: jest.Mock };
  let gateway: ChatGateway;

  const client = (
    user: any = { steam_id: "1", name: "Mod", role: "moderator" },
  ) => ({ id: "client-1", user, send: jest.fn() }) as any;

  const sent = (socket: { send: jest.Mock }) =>
    socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

  beforeEach(() => {
    chat = { deleteMessage: jest.fn().mockResolvedValue({ deleted: true }) };
    gateway = new ChatGateway(chat as any);
  });

  it("ignores a socket that has not signed in", async () => {
    const socket = client(null);

    await gateway.deleteMessage(
      {
        id: "m-1",
        type: ChatLobbyType.Match,
        messageId: MESSAGE_ID,
        requestId: "r-1",
      },
      socket,
    );

    expect(chat.deleteMessage).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown lobby type", { type: "global", id: "m-1", messageId: "x" }],
    [
      "a room id that is not a string",
      { type: "match", id: 1, messageId: "x" },
    ],
    ["a missing message id", { type: "match", id: "m-1" }],
    ["a missing payload", undefined],
  ])("ignores %s", async (_, data) => {
    const socket = client();

    await gateway.deleteMessage(data as any, socket);

    expect(chat.deleteMessage).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("asks the service to delete as the signed in player", async () => {
    await gateway.deleteMessage(
      { id: "m-1", type: ChatLobbyType.Match, messageId: MESSAGE_ID },
      client(),
    );

    expect(chat.deleteMessage).toHaveBeenCalledWith(
      ChatLobbyType.Match,
      "m-1",
      MESSAGE_ID,
      expect.objectContaining({ steam_id: "1" }),
    );
  });

  it("acks a deletion under the requestId it came with", async () => {
    const socket = client();

    await gateway.deleteMessage(
      {
        id: "m-1",
        type: ChatLobbyType.Match,
        messageId: MESSAGE_ID,
        requestId: "r-2",
      },
      socket,
    );

    expect(sent(socket)).toEqual([
      {
        event: "chat:ack",
        data: { requestId: "r-2", messageId: MESSAGE_ID, action: "delete" },
      },
    ]);
  });

  it("stays quiet for a deletion without a requestId", async () => {
    const socket = client();

    await gateway.deleteMessage(
      { id: "m-1", type: ChatLobbyType.Match, messageId: MESSAGE_ID },
      socket,
    );

    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([ChatErrorCode.NotAllowed, ChatErrorCode.NotFound])(
    "reports %s under the requestId it came with",
    async (code) => {
      chat.deleteMessage.mockResolvedValue({ deleted: false, code });
      const socket = client();

      await gateway.deleteMessage(
        {
          id: "m-1",
          type: ChatLobbyType.Match,
          messageId: MESSAGE_ID,
          requestId: "r-3",
        },
        socket,
      );

      expect(sent(socket)).toEqual([
        {
          event: "chat:error",
          data: { code, action: "delete", requestId: "r-3" },
        },
      ]);
    },
  );

  it("still reports a refusal without a requestId", async () => {
    chat.deleteMessage.mockResolvedValue({
      deleted: false,
      code: ChatErrorCode.NotAllowed,
    });
    const socket = client();

    await gateway.deleteMessage(
      { id: "x", type: ChatLobbyType.Direct, messageId: MESSAGE_ID },
      socket,
    );

    expect(sent(socket)).toEqual([
      {
        event: "chat:error",
        data: { code: "not_allowed", action: "delete" },
      },
    ]);
  });
});

describe("ChatGateway lobby:edit", () => {
  const MESSAGE_ID = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

  let chat: { editMessage: jest.Mock; sendChatToServer: jest.Mock };
  let gateway: ChatGateway;

  const client = (user: any = { steam_id: "1", name: "Luke", role: "user" }) =>
    ({ id: "client-1", user, send: jest.fn() }) as any;

  const sent = (socket: { send: jest.Mock }) =>
    socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

  const edit = (overrides: Record<string, unknown> = {}) => ({
    id: "m-1",
    type: ChatLobbyType.Match,
    messageId: MESSAGE_ID,
    message: "fixed",
    ...overrides,
  });

  beforeEach(() => {
    chat = {
      editMessage: jest.fn().mockResolvedValue({
        edited: true,
        message: "fixed",
        edited_at: "2026-01-01T00:00:00.000Z",
      }),
      sendChatToServer: jest.fn(),
    };
    gateway = new ChatGateway(chat as any);
  });

  it("ignores a socket that has not signed in", async () => {
    const socket = client(null);

    await gateway.editMessage(edit({ requestId: "r-1" }) as any, socket);

    expect(chat.editMessage).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown lobby type", { type: "global" }],
    ["a room id that is not a string", { id: 1 }],
    ["a missing message id", { messageId: undefined }],
  ])("ignores %s", async (_, overrides) => {
    const socket = client();

    await gateway.editMessage(edit(overrides) as any, socket);

    expect(chat.editMessage).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([
    ["only whitespace", "  \n "],
    ["not a string", 5],
  ])("answers an edit that is %s with invalid", async (_, message) => {
    const socket = client();

    await gateway.editMessage(
      edit({ message, requestId: "r-4" }) as any,
      socket,
    );

    expect(chat.editMessage).not.toHaveBeenCalled();
    expect(sent(socket)).toEqual([
      {
        event: "chat:error",
        data: { code: ChatErrorCode.Invalid, action: "edit", requestId: "r-4" },
      },
    ]);
  });

  it("ignores a missing payload", async () => {
    await gateway.editMessage(undefined as any, client());

    expect(chat.editMessage).not.toHaveBeenCalled();
  });

  it("asks the service to edit as the signed in player, with the trimmed text", async () => {
    await gateway.editMessage(edit({ message: "  fixed  " }) as any, client());

    expect(chat.editMessage).toHaveBeenCalledWith(
      ChatLobbyType.Match,
      "m-1",
      MESSAGE_ID,
      expect.objectContaining({ steam_id: "1" }),
      "fixed",
    );
  });

  it("refuses an edit over the limit without asking the service", async () => {
    const socket = client();

    await gateway.editMessage(
      edit({
        message: "a".repeat(ChatService.MAX_MESSAGE_LENGTH + 1),
        requestId: "r-1",
      }) as any,
      socket,
    );

    expect(chat.editMessage).not.toHaveBeenCalled();
    expect(sent(socket)).toEqual([
      {
        event: "chat:error",
        data: {
          code: ChatErrorCode.TooLong,
          action: "edit",
          max: 2000,
          requestId: "r-1",
        },
      },
    ]);
  });

  it("acks an edit under the requestId it came with, with what the server stored", async () => {
    chat.editMessage.mockResolvedValue({
      edited: true,
      message: "fixed as stored",
      edited_at: "2026-02-03T04:05:06.789Z",
    });
    const socket = client();

    await gateway.editMessage(edit({ requestId: "r-2" }) as any, socket);

    expect(sent(socket)).toEqual([
      {
        event: "chat:ack",
        data: {
          requestId: "r-2",
          messageId: MESSAGE_ID,
          action: "edit",
          message: "fixed as stored",
          edited_at: "2026-02-03T04:05:06.789Z",
        },
      },
    ]);
  });

  it("stays quiet for an edit without a requestId", async () => {
    const socket = client();

    await gateway.editMessage(edit() as any, socket);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([
    ChatErrorCode.NotAllowed,
    ChatErrorCode.NotFound,
    ChatErrorCode.WindowClosed,
    ChatErrorCode.Gagged,
  ])("reports %s under the requestId it came with", async (code) => {
    chat.editMessage.mockResolvedValue({ edited: false, code });
    const socket = client();

    await gateway.editMessage(edit({ requestId: "r-3" }) as any, socket);

    expect(sent(socket)).toEqual([
      {
        event: "chat:error",
        data: { code, action: "edit", requestId: "r-3" },
      },
    ]);
  });

  it("never relays an edit to the game server", async () => {
    await gateway.editMessage(edit() as any, client());

    expect(chat.editMessage).toHaveBeenCalled();
    expect(chat.sendChatToServer).not.toHaveBeenCalled();
  });
});

describe("ChatGateway lobby:react", () => {
  const MESSAGE_ID = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

  let chat: { toggleReaction: jest.Mock; sendChatToServer: jest.Mock };
  let gateway: ChatGateway;

  const client = (user: any = { steam_id: "1", name: "Luke", role: "user" }) =>
    ({ id: "client-1", user, send: jest.fn() }) as any;

  const sent = (socket: { send: jest.Mock }) =>
    socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

  const reaction = (overrides: Record<string, unknown> = {}) => ({
    id: "m-1",
    type: ChatLobbyType.Match,
    messageId: MESSAGE_ID,
    reaction: "heart",
    ...overrides,
  });

  beforeEach(() => {
    chat = {
      toggleReaction: jest.fn().mockResolvedValue({
        toggled: true,
        reactions: { heart: ["1"] },
      }),
      sendChatToServer: jest.fn(),
    };
    gateway = new ChatGateway(chat as any);
  });

  it("ignores a socket that has not signed in", async () => {
    const socket = client(null);

    await gateway.react(reaction({ requestId: "r-1" }) as any, socket);

    expect(chat.toggleReaction).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown lobby type", { type: "global" }],
    ["a room id that is not a string", { id: 1 }],
    ["a missing message id", { messageId: undefined }],
  ])("ignores %s", async (_, overrides) => {
    const socket = client();

    await gateway.react(reaction(overrides) as any, socket);

    expect(chat.toggleReaction).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("ignores a missing payload", async () => {
    await gateway.react(undefined as any, client());

    expect(chat.toggleReaction).not.toHaveBeenCalled();
  });

  it.each([
    ["not on the list", "party"],
    ["not a string", 5],
    ["missing", undefined],
  ])(
    "answers a reaction that is %s with invalid, without asking the service",
    async (_, value) => {
      const socket = client();

      await gateway.react(
        reaction({ reaction: value, requestId: "r-2" }) as any,
        socket,
      );

      expect(chat.toggleReaction).not.toHaveBeenCalled();
      expect(sent(socket)).toEqual([
        {
          event: "chat:error",
          data: {
            code: ChatErrorCode.Invalid,
            action: "react",
            requestId: "r-2",
          },
        },
      ]);
    },
  );

  it("asks the service to toggle as the signed in player", async () => {
    await gateway.react(reaction({ reaction: "laugh" }) as any, client());

    expect(chat.toggleReaction).toHaveBeenCalledWith(
      ChatLobbyType.Match,
      "m-1",
      MESSAGE_ID,
      "laugh",
      expect.objectContaining({ steam_id: "1" }),
    );
  });

  it("acks a toggle under the requestId it came with", async () => {
    const socket = client();

    await gateway.react(reaction({ requestId: "r-3" }) as any, socket);

    expect(sent(socket)).toEqual([
      {
        event: "chat:ack",
        data: { requestId: "r-3", messageId: MESSAGE_ID, action: "react" },
      },
    ]);
  });

  it("stays quiet for a toggle without a requestId", async () => {
    const socket = client();

    await gateway.react(reaction() as any, socket);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([
    ChatErrorCode.RateLimited,
    ChatErrorCode.NotAllowed,
    ChatErrorCode.NotFound,
    ChatErrorCode.Gagged,
  ])("reports %s under the requestId it came with", async (code) => {
    chat.toggleReaction.mockResolvedValue({ toggled: false, code });
    const socket = client();

    await gateway.react(reaction({ requestId: "r-4" }) as any, socket);

    expect(sent(socket)).toEqual([
      {
        event: "chat:error",
        data: { code, action: "react", requestId: "r-4" },
      },
    ]);
  });

  it("never relays a reaction to the game server", async () => {
    await gateway.react(reaction() as any, client());

    expect(chat.toggleReaction).toHaveBeenCalled();
    expect(chat.sendChatToServer).not.toHaveBeenCalled();
  });
});
