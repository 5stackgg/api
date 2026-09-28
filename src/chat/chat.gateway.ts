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
        this.sendError(client, parsed.error, requestId);
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
        this.sendError(client, result.code, requestId);
      }
      return;
    }

    if (requestId) {
      this.sendAck(client, requestId, result.messageId);
    }

    if (data.type !== ChatLobbyType.Match) {
      return;
    }

    await this.chat.sendChatToServer(
      data.id,
      `${isRoleAbove(client.user.role, "match_organizer") ? `[organizer] ` : ""}${client.user.name}: ${parsed.text}`.replaceAll(
        `"`,
        `'`,
      ),
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
      this.sendError(client, result.code, requestId);
      return;
    }

    if (requestId) {
      this.sendAck(client, requestId, data.messageId);
    }
  }

  private static isLobbyType(value: unknown): value is ChatLobbyType {
    return Object.values(ChatLobbyType).includes(value as ChatLobbyType);
  }

  private sendError(
    client: FiveStackWebSocketClient,
    code: ChatErrorCode,
    requestId?: string,
  ) {
    client.send(
      JSON.stringify({
        event: "chat:error",
        data: {
          code,
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
    requestId: string,
    messageId: string,
  ) {
    client.send(
      JSON.stringify({
        event: "chat:ack",
        data: { requestId, messageId },
      }),
    );
  }
}
