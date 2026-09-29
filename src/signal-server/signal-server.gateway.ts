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
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";

@WebSocketGateway({
  path: "/ws/web",
})
export class SignalServerGateway {
  // The web opens one peer per region it measures; a socket claiming more
  // than this forgets its oldest.
  private static readonly MAX_SIGNAL_PEERS = 32;

  constructor(
    private readonly hasura: HasuraService,
    @Inject("GAME_SERVER_NODE_CLIENT_SERVICE") private client: ClientProxy,
  ) {}

  // A socket may only signal the peers it offered itself: an offer claims its
  // peerId on that socket and the node it went to, and a candidate is relayed
  // only for a peerId that socket claimed, to that same node.
  @SubscribeMessage("offer")
  public async handleOffer(
    @MessageBody()
    data: RegionSignalData,
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (
      !client.user ||
      typeof data?.region !== "string" ||
      typeof data.peerId !== "string"
    ) {
      return;
    }

    const { region, signal, peerId } = data;

    const node = this.getRegionServer(region).then((server) => server?.id);

    // Claimed before the first await: the candidates that follow an offer on
    // the same socket have to find it.
    client.signalPeers.set(peerId, node);

    if (client.signalPeers.size > SignalServerGateway.MAX_SIGNAL_PEERS) {
      client.signalPeers.delete(client.signalPeers.keys().next().value);
    }

    const nodeId = await node;

    if (!nodeId) {
      return;
    }

    client.peerNodes.add(nodeId);

    this.client.emit(`offer.${nodeId}`, {
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
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user || typeof data?.peerId !== "string") {
      return;
    }

    const { region, signal, peerId } = data;

    const nodeId = await client.signalPeers.get(peerId);

    if (!nodeId) {
      return;
    }

    this.client.emit(`candidate.${nodeId}`, {
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
