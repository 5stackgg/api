import { WebSocket } from "ws";
import { HasuraService } from "src/hasura/hasura.service";
import {
  SubscribeMessage,
  WebSocketGateway,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { RegionSignalData } from "./types/SignalData";

interface WebRTCClient extends WebSocket {
  id: string;
  sessionId: string;
}

@WebSocketGateway({
  path: "/ws/web",
})
export class SignalServerGateway {
  private redis: Redis;

  constructor(
    private readonly hasura: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly logger: Logger,
  ) {
    this.redis = this.redisManager.getConnection();
  }

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

    this.redis.publish(
      `send-message-to-node-ip`,
      JSON.stringify({
        nodeIp: server.node_ip,
        event: "offer",
        data: {
          region,
          signal,
          peerId,
          clientId: client.id,
          sessionId: client.sessionId,
        },
      }),
    );
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

    this.redis.publish(
      `send-message-to-node-ip`,
      JSON.stringify({
        nodeIp: server.node_ip,
        event: "candidate",
        data: {
          region,
          signal,
          peerId,
          clientId: client.id,
        },
      }),
    );
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
