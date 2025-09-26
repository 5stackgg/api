import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { Request } from "express";
import { FiveStackWebSocketClient } from "./types/FiveStackWebSocketClient";
import { SocketsService } from "./sockets.service";

@WebSocketGateway({
  path: "/ws/web",
})
export class SocketsGateway {
  constructor(private readonly sockets: SocketsService) {}

  @SubscribeMessage("ping")
  public async handleMessage(client: FiveStackWebSocketClient): Promise<void> {
    if (!client.user) {
      return;
    }

    await this.sockets.updateClient(client.user.steam_id, client.id);
  }

  private async handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request,
  ) {
    await this.sockets.setupSocket(client, request);
  }
}
