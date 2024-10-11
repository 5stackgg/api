import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { MatchLobbyService } from "../matches/match-lobby.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";

@WebSocketGateway({
  path: "/ws/web",
})
export class MatchLobbyGateway {
  constructor(private readonly matchLobby: MatchLobbyService) {}

  @SubscribeMessage("lobby:join")
  async joinLobby(
    @MessageBody()
    data: {
      matchId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await this.matchLobby.joinMatchLobby(client, data.matchId);
  }

  @SubscribeMessage("lobby:leave")
  async leaveLobby(
    @MessageBody()
    data: {
      matchId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    this.matchLobby.removeFromLobby(data.matchId, client);
  }

  @SubscribeMessage("lobby:chat")
  async lobby(
    @MessageBody()
    data: {
      matchId: string;
      message: string;
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

    await this.matchLobby.sendMessageToChat(
      client.user,
      data.matchId,
      data.message,
    );
    await this.matchLobby.sendChatToServer(
      data.matchId,
      `${client.user.role ? `[${client.user.role}] ` : ""}${client.user.name}: ${data.message}`.replaceAll(
        `"`,
        `'`,
      ),
    );
  }
}
