import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import WebSocket from "ws";
import { Request } from "express";
import { User } from "../auth/types/User";
import { RconService } from "../rcon/rcon.service";
import { MatchSocketsService } from "./match-sockets.service";

export type FiveStackWebSocketClient = WebSocket.WebSocket & {
  user: User;
};

/**
 * TODO - use redis to keep state,
 * right now this is not scaleable because were using a single service to track sessions
 */
@WebSocketGateway({
  path: "/ws",
})
export class ServerGateway {
  constructor(
    private readonly rconService: RconService,
    private readonly matchSockets: MatchSocketsService,
  ) {}

  async handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request,
  ) {
    this.matchSockets.setupSocket(client, request);
  }

  @SubscribeMessage("lobby:join")
  async joinLobby(
    @MessageBody()
    data: {
      matchId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await this.matchSockets.joinLobby(client, data.matchId);
  }

  @SubscribeMessage("lobby:leave")
  async leaveLobby(
    @MessageBody()
    data: {
      matchId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    this.matchSockets.removeFromLobby(data.matchId, client);
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
    await this.matchSockets.sendMessageToChat(
      client.user,
      data.matchId,
      data.message,
    );
    await this.matchSockets.sendChatToServer(
      data.matchId,
      `${client.user.role ? `[${client.user.role}] ` : ""}${client.user.name}: ${data.message}`.replaceAll(
        `"`,
        `'`,
      ),
    );
  }

  @SubscribeMessage("rcon")
  async rconEvent(
    @MessageBody()
    data: {
      uuid: string;
      command: string;
      serverId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const rcon = await this.rconService.connect(data.serverId);

    client.send(
      JSON.stringify({
        event: "rcon",
        data: {
          uuid: data.uuid,
          result: await rcon.send(data.command),
        },
      }),
    );
  }
}
