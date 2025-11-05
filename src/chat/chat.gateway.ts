import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { ChatService } from "./chat.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
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

  @SubscribeMessage("lobby:chat")
  async lobby(
    @MessageBody()
    data: {
      id: string;
      message: string;
      type: ChatLobbyType;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!data.message) {
      return;
    }

    data.message = data.message.trim();

    if (data.message.length === 0) {
      return;
    }

    await this.chat.sendMessageToChat(
      data.type,
      data.id,
      client.user,
      data.message,
    );

    if (data.type !== ChatLobbyType.Match) {
      return;
    }

    await this.chat.sendChatToServer(
      data.id,
      `${isRoleAbove(client.user.role, "match_organizer") ? `[organizer] ` : ""}${client.user.name}: ${data.message}`.replaceAll(
        `"`,
        `'`,
      ),
    );
  }
}
