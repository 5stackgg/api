import Redis from "ioredis";
import WebSocket from "ws";
import { Queue } from "bullmq";
import type { Request } from "express";
import { InjectQueue } from "@nestjs/bullmq";
import { GameServerQueues } from "./enums/GameServerQueues";
import { GameServerNodeService } from "./game-server-node.service";
import {
  SubscribeMessage,
  WebSocketGateway,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { MarkGameServerNodeOffline } from "./jobs/MarkGameServerNodeOffline";
import { NodeStats } from "./interfaces/NodeStats";
import { PodStats } from "./interfaces/PodStats";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { Logger } from "@nestjs/common";
import { PeerSignalData } from "src/signal-server/types/SignalData";

@WebSocketGateway(5586, {
  path: "/ws",
})
export class GameServerNodeGateway {
  public redis: Redis;
  private clients: Map<string, WebSocket> = new Map();

  constructor(
    private readonly logger: Logger,
    private readonly redisManager: RedisManagerService,
    private readonly gameServerNodeService: GameServerNodeService,
    @InjectQueue(GameServerQueues.NodeOffline) private readonly queue: Queue,
  ) {
    this.redis = this.redisManager.getConnection();
    const sub = this.redisManager.getConnection("sub");

    sub.subscribe("send-message-to-node-ip");
    sub.on("message", (channel: string, message: string) => {
      const { nodeIp, event, data } = JSON.parse(message) as {
        nodeIp: string;
        event: string;
        data: unknown;
      };

      switch (channel) {
        case "send-message-to-node-ip":
          this.sendMessageToGameServerNode(nodeIp, event, data);
          break;
      }
    });
  }

  @SubscribeMessage("connection")
  private async handleConnection(
    @ConnectedSocket() client: WebSocket & { id: string },
    request: Request,
  ): Promise<void> {
    const nodeId = request.headers["x-node-ip"] as string;
    if (!nodeId) return;

    this.clients.set(nodeId, client);

    client.on("close", async () => {
      this.clients.delete(nodeId);
    });
  }

  @SubscribeMessage("message")
  public async handleMessage(
    client: WebSocket,
    payload: {
      node: string;
      lanIP: string;
      nodeIP: string;
      publicIP: string;
      csBuild: number;
      supportsLowLatency: boolean;
      supportsCpuPinning: boolean;
      nodeStats: NodeStats;
      podStats: Array<PodStats>;
      labels: Record<string, string>;
    },
  ): Promise<void> {
    if (!payload.labels?.["5stack-id"]) {
      await this.gameServerNodeService.updateIdLabel(payload.node);
    }

    await this.gameServerNodeService.updateStatus(
      payload.node,
      payload.nodeIP,
      payload.lanIP,
      payload.publicIP,
      payload.csBuild,
      payload.supportsCpuPinning,
      payload.supportsLowLatency,
      payload.nodeStats.cpuInfo,
      payload.nodeStats.nvidiaGPU,
      "Online",
    );

    if (payload.nodeStats && payload.podStats) {
      await this.gameServerNodeService.captureNodeStats(
        payload.node,
        payload.nodeStats,
      );

      await this.gameServerNodeService.capturePodStats(
        payload.node,
        payload.nodeStats.cpuCapacity,
        payload.nodeStats.memoryCapacity,
        payload.podStats,
      );
    }

    const jobId = `node:${payload.node}`;
    await this.queue.remove(jobId);

    await this.queue.add(
      MarkGameServerNodeOffline.name,
      {
        node: payload.node,
      },
      {
        delay: 90 * 1000,
        attempts: 1,
        removeOnFail: false,
        removeOnComplete: true,
        jobId,
      },
    );
  }

  @SubscribeMessage("answer")
  public async handleAnswer(
    @MessageBody()
    data: PeerSignalData,
  ) {
    this.handleIceCandidate(data);
  }

  @SubscribeMessage("candidate")
  public async handleIceCandidate(
    @MessageBody()
    data: PeerSignalData,
  ) {
    const { peerId, clientId, signal } = data;

    if (!peerId || !clientId) {
      this.logger.error("No peerId or clientId found");
      return;
    }

    await this.redis.publish(
      `send-message-to-client`,
      JSON.stringify({
        clientId,
        event: "candidate",
        data: {
          peerId,
          signal,
        },
      }),
    );
  }

  private async sendMessageToGameServerNode(
    nodeIP: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    const client = this.clients.get(nodeIP);

    if (!client) {
      return;
    }

    client.send(
      JSON.stringify({
        event,
        data,
      }),
    );
  }
}
