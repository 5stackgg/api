import WebSocket from "ws";
import { Queue } from "bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { GameServerQueues } from "./enums/GameServerQueues";
import { GameServerNodeService } from "./game-server-node.service";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { MarkGameServerNodeOffline } from "./jobs/MarkGameServerNodeOffline";
import { NodeStats } from "./jobs/NodeStats";
import { PodStats } from "./jobs/PodStats";

@WebSocketGateway(5586, {
  path: "/ws",
})
export class GameServerNodeGateway {
  constructor(
    protected readonly cache: CacheService,
    protected readonly hasura: HasuraService,
    protected readonly gameServerNodeService: GameServerNodeService,
    @InjectQueue(GameServerQueues.NodeOffline) private queue: Queue,
  ) {}

  @SubscribeMessage("message")
  public async handleMessage(
    client: WebSocket,
    payload: {
      node: string;
      lanIP: string;
      publicIP: string;
      csBuild: number;
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
      payload.lanIP,
      payload.publicIP,
      payload.csBuild,
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
        delay: 65 * 1000,
        attempts: 1,
        removeOnFail: false,
        removeOnComplete: true,
        jobId,
      },
    );
  }
}
