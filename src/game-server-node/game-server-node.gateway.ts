import WebSocket from "ws";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { HasuraService } from "../hasura/hasura.service";
import { CacheService } from "../cache/cache.service";
import { GameServerNodeService } from "./game-server-node.service";

@WebSocketGateway(5586, {
  path: "/ws",
})
export class GameServerNodeGateway {
  constructor(
    protected readonly cache: CacheService,
    protected readonly hasura: HasuraService,
    protected readonly gameServerNodeService: GameServerNodeService,
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
  }
}
