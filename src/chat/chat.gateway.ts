import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { ChatService } from "./chat.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatAction } from "./types/ChatAction";
import { isRoleAbove } from "@utilities/isRoleAbove";

@WebSocketGateway({
  path: "/ws/web",
})
export class ChatGateway {
  constructor(private readonly chat: ChatService) {}

  @SubscribeMessage("lobby:join")
  async joinLobby(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user) {
      return;
    }

    await this.chat.joinMatchLobby(client, data.type, data.id);
  }

  @SubscribeMessage("lobby:leave")
  async leaveLobby(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user) {
      return;
    }

    void this.chat.removeFromLobby(data.type, data.id, client);
  }

  @SubscribeMessage("lobby:read")
  async markRead(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user) {
      return;
    }

    // Every lobby type, not just DMs: the read cursor is what stops a push
    // firing for a conversation the recipient is already caught up on, and a
    // match lobby is where that happens most.
    const read = await this.chat.markThreadRead(
      data.type,
      data.id,
      client.user,
    );

    if (!read) {
      return;
    }

    // The client stamped its own cursor from the browser clock so the badge
    // cleared at once. Message timestamps come from here, so a browser running
    // slow would leave every message newer than its own cursor -- this is the
    // value postgres actually wrote.
    client.send(
      JSON.stringify({
        event: "chat:read",
        data: read,
      }),
    );
  }

  @SubscribeMessage("lobby:chat")
  async lobby(
    @MessageBody()
    data: {
      id: string;
      message: unknown;
      type: ChatLobbyType;
      requestId?: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user) {
      return;
    }

    if (!ChatGateway.isLobbyType(data?.type) || typeof data.id !== "string") {
      return;
    }

    const requestId =
      typeof data.requestId === "string" ? data.requestId : undefined;

    const parsed = ChatService.messageText(data.message);

    if ("error" in parsed) {
      if (parsed.error === ChatErrorCode.TooLong) {
        this.sendError(client, "send", parsed.error, requestId);
      }
      return;
    }

    const result = await this.chat.sendMessageToChat(
      data.type,
      data.id,
      client.user,
      parsed.text,
    );

    // Only a message the room accepted may reach the game server: the relay
    // does no membership check of its own, so relaying regardless would let
    // any signed-in socket print into any live match.
    if (result.accepted === false) {
      if (result.code) {
        this.sendError(client, "send", result.code, requestId);
      }
      return;
    }

    if (requestId) {
      this.sendAck(client, "send", requestId, result.messageId);
    }

    if (data.type !== ChatLobbyType.Match) {
      return;
    }

    const isOrganizer = isRoleAbove(client.user.role, "match_organizer");

    // The tag stays in the line for plugins that predate the flag.
    await this.chat.sendChatToServer(
      data.id,
      `${isOrganizer ? `[organizer] ` : ""}${client.user.name}: ${parsed.text}`.replaceAll(
        `"`,
        `'`,
      ),
      isOrganizer,
    );
  }

  @SubscribeMessage("lobby:delete")
  async deleteMessage(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
      messageId: string;
      requestId?: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user) {
      return;
    }

    if (
      !ChatGateway.isLobbyType(data?.type) ||
      typeof data.id !== "string" ||
      typeof data.messageId !== "string"
    ) {
      return;
    }

    const requestId =
      typeof data.requestId === "string" ? data.requestId : undefined;

    const result = await this.chat.deleteMessage(
      data.type,
      data.id,
      data.messageId,
      client.user,
    );

    if (result.deleted === false) {
      this.sendError(client, "delete", result.code, requestId);
      return;
    }

    if (requestId) {
      this.sendAck(client, "delete", requestId, data.messageId);
    }
  }

  @SubscribeMessage("lobby:edit")
  async editMessage(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
      messageId: string;
      message: unknown;
      requestId?: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user) {
      return;
    }

    if (
      !ChatGateway.isLobbyType(data?.type) ||
      typeof data.id !== "string" ||
      typeof data.messageId !== "string"
    ) {
      return;
    }

    const requestId =
      typeof data.requestId === "string" ? data.requestId : undefined;

    const parsed = ChatService.messageText(data.message);

    // Unlike a send, clearing the box is an ordinary thing to do to an edit,
    // so the client is told rather than left waiting.
    if ("error" in parsed) {
      this.sendError(client, "edit", parsed.error, requestId);
      return;
    }

    const result = await this.chat.editMessage(
      data.type,
      data.id,
      data.messageId,
      client.user,
      parsed.text,
    );

    if (result.edited === false) {
      this.sendError(client, "edit", result.code, requestId);
      return;
    }

    if (requestId) {
      this.sendAck(client, "edit", requestId, data.messageId, {
        message: result.message,
        edited_at: result.edited_at,
      });
    }
  }

  @SubscribeMessage("lobby:react")
  async react(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
      messageId: string;
      reaction: unknown;
      requestId?: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user) {
      return;
    }

    if (
      !ChatGateway.isLobbyType(data?.type) ||
      typeof data.id !== "string" ||
      typeof data.messageId !== "string"
    ) {
      return;
    }

    const requestId =
      typeof data.requestId === "string" ? data.requestId : undefined;

    if (!ChatService.isReaction(data.reaction)) {
      this.sendError(client, "react", ChatErrorCode.Invalid, requestId);
      return;
    }

    const result = await this.chat.toggleReaction(
      data.type,
      data.id,
      data.messageId,
      data.reaction,
      client.user,
    );

    if (result.toggled === false) {
      this.sendError(client, "react", result.code, requestId);
      return;
    }

    if (requestId) {
      this.sendAck(client, "react", requestId, data.messageId);
    }
  }

  private static isLobbyType(value: unknown): value is ChatLobbyType {
    return Object.values(ChatLobbyType).includes(value as ChatLobbyType);
  }

  private sendError(
    client: FiveStackWebSocketClient,
    action: ChatAction,
    code: ChatErrorCode,
    requestId?: string,
  ) {
    client.send(
      JSON.stringify({
        event: "chat:error",
        data: {
          code,
          action,
          ...(code === ChatErrorCode.TooLong
            ? { max: ChatService.MAX_MESSAGE_LENGTH }
            : {}),
          ...(requestId ? { requestId } : {}),
        },
      }),
    );
  }

  private sendAck(
    client: FiveStackWebSocketClient,
    action: ChatAction,
    requestId: string,
    messageId: string,
    extra: Record<string, string> = {},
  ) {
    client.send(
      JSON.stringify({
        event: "chat:ack",
        data: { ...extra, requestId, messageId, action },
      }),
    );
  }
}
