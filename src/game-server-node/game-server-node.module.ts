import { Module } from "@nestjs/common";
import { GameServerNodeService } from "./game-server-node.service";
import { GameServerNodeController } from "./game-server-node.controller";
import { TailscaleModule } from "../tailscale/tailscale.module";
import { HasuraModule } from "../hasura/hasura.module";
import { GameServerNodeGateway } from "./game-server-node.gateway";
import { CacheModule } from "../cache/cache.module";
import { CheckGameUpdate } from "./jobs/CheckGameUpdate";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { GameServeQueues } from "./enums/GameServeQueues";

@Module({
  providers: [GameServerNodeService, GameServerNodeGateway, CheckGameUpdate],
  imports: [
    TailscaleModule,
    HasuraModule,
    CacheModule,
    BullModule.registerQueue({
      name: GameServeQueues.GameUpdate,
    }),
    BullBoardModule.forFeature({
      name: GameServeQueues.GameUpdate,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [GameServerNodeController],
})
export class GameServerNodeModule {
  constructor(@InjectQueue(GameServeQueues.GameUpdate) private queue: Queue) {
    void queue.add(
      CheckGameUpdate.name,
      {},
      {
        repeat: {
          pattern: "*/6 * * * *",
        },
      },
    );
  }
}
