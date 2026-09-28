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
      sendMessageToChat: jest.fn().mockResolvedValue({ accepted: true }),
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
      );
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
          data: { code: ChatErrorCode.TooLong, max: 2000, requestId: "r-1" },
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
        { event: "chat:error", data: { code: "too_long", max: 2000 } },
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
          data: { code: ChatErrorCode.NotAllowed, requestId: "r-2" },
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
      );
    });

    it("marks an organizer's relayed message", async () => {
      await gateway.lobby(
        { id: "m-1", type: ChatLobbyType.Match, message: "pause please" },
        client({ steam_id: "1", name: "Luke", role: "administrator" }),
      );

      expect(chat.sendChatToServer).toHaveBeenCalledWith(
        "m-1",
        "[organizer] Luke: pause please",
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
        { event: "chat:ack", data: { requestId: "r-3" } },
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
