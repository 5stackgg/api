import WebSocket from "ws";
import { Queue } from "bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { GameServerQueues } from "./enums/GameServerQueues";
import { GameServerNodeService } from "./game-server-node.service";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { MarkGameServerNodeOffline } from "./jobs/MarkGameServerNodeOffline";

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
      labels: Record<string, string>;
    },
  ): Promise<void> {
    const [start_port_range, end_port_range] = payload.labels?.[
      "5stack-ports"
    ]?.split("_") || [,];
    await this.gameServerNodeService.updateStatus(
      payload.node,
      "Online",
      start_port_range && parseInt(start_port_range),
      end_port_range && parseInt(end_port_range),
    );

    await this.queue.add(
      MarkGameServerNodeOffline.name,
      {
        node: payload.node,
      },
      {
        delay: 65 * 1000,
        attempts: 1,
        removeOnFail: true,
        removeOnComplete: true,
        jobId: `node:${payload.node}`,
      },
    );
  }
}
