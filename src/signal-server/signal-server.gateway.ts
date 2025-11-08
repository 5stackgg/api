import { WebSocket } from "ws";
import { HasuraService } from "src/hasura/hasura.service";
import {
  SubscribeMessage,
  WebSocketGateway,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Inject } from "@nestjs/common";
import { RegionSignalData } from "./types/SignalData";
import { ClientProxy } from "@nestjs/microservices";

interface WebRTCClient extends WebSocket {
  id: string;
  sessionId: string;
}

@WebSocketGateway({
  path: "/ws/web",
})
export class SignalServerGateway {
  constructor(
    private readonly hasura: HasuraService,
    @Inject("GAME_SERVER_NODE_CLIENT_SERVICE") private client: ClientProxy,
  ) {}

  @SubscribeMessage("offer")
  public async handleOffer(
    @MessageBody()
    data: RegionSignalData,
    @ConnectedSocket() client: WebRTCClient,
  ) {
    const { region, signal, peerId } = data;

    const server = await this.getRegionServer(region);

    if (!server) {
      return;
    }

    this.client.emit(`offer.${server.id}`, {
      region,
      signal,
      peerId,
      clientId: client.id,
      sessionId: client.sessionId,
    });
  }

  @SubscribeMessage("candidate")
  public async handleIceCandidate(
    @MessageBody()
    data: RegionSignalData,
    @ConnectedSocket() client: WebRTCClient,
  ) {
    const { region, signal, peerId } = data;
    const server = await this.getRegionServer(region);

    if (!server) {
      return;
    }

    this.client.emit(`candidate.${server.id}`, {
      region,
      signal,
      peerId,
      clientId: client.id,
    });
  }

  private async getRegionServer(region: string) {
    const data = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            region: {
              _eq: region,
            },
            status: {
              _eq: "Online",
            },
            enabled: {
              _eq: true,
            },
          },
        },
        id: true,
        node_ip: true,
        status: true,
      },
    });

    return data.game_server_nodes.at(0);
  }
}
