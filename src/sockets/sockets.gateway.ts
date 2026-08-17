import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { Request } from "express";
import { FiveStackWebSocketClient } from "./types/FiveStackWebSocketClient";
import { SocketsService } from "./sockets.service";

@WebSocketGateway({
  path: "/ws/web",
})
export class SocketsGateway implements OnGatewayConnection {
  constructor(private readonly sockets: SocketsService) {}

  @SubscribeMessage("ping")
  public async handleMessage(client: FiveStackWebSocketClient): Promise<void> {
    if (!client.user) {
      return;
    }

    await this.sockets.updateClient(client.user.steam_id, client.id);
  }

  // What this tab is showing, so a notification can decide not to buzz someone
  // who is already reading it. `focus` is a thread key -- see
  // notifications/push/notification-delivery.ts threadKeyFor.
  //
  // A hidden tab reports no focus at all: a backgrounded window is still a live
  // socket, and treating it as "reading" is how a phone goes silent for a
  // conversation nobody is looking at.
  @SubscribeMessage("presence")
  public async handlePresence(
    @MessageBody() data: { visible?: boolean; focus?: string | null },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ): Promise<void> {
    if (!client.user) {
      return;
    }

    await this.sockets.setFocus(
      client.user.steam_id,
      client.id,
      data?.visible && typeof data.focus === "string" ? data.focus : null,
    );
  }

  public async handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request,
  ) {
    await this.sockets.setupSocket(client, request);
  }
}
