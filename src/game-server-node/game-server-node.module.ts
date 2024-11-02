import { MiddlewareConsumer, Module, RequestMethod } from "@nestjs/common";
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
import { GameServerQueues } from "./enums/GameServerQueues";
import { MarkGameServerNodeOffline } from "./jobs/MarkGameServerNodeOffline";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchServerMiddlewareMiddleware } from "../matches/match-server-middleware/match-server-middleware.middleware";
import { MarkGameServerOffline } from "./jobs/MarkGameServerOffline";
import { LoggingServiceService } from "./logging-service/logging-service.service";

@Module({
  providers: [
    GameServerNodeService,
    GameServerNodeGateway,
    CheckGameUpdate,
    MarkGameServerNodeOffline,
    MarkGameServerOffline,
    ...getQueuesProcessors("GameServerNode"),
    loggerFactory(),
    LoggingServiceService,
  ],
  imports: [
    TailscaleModule,
    HasuraModule,
    CacheModule,
    BullModule.registerQueue(
      {
        name: GameServerQueues.GameUpdate,
      },
      {
        name: GameServerQueues.NodeOffline,
      },
    ),
    BullBoardModule.forFeature(
      {
        name: GameServerQueues.GameUpdate,
        adapter: BullMQAdapter,
      },
      {
        name: GameServerQueues.NodeOffline,
        adapter: BullMQAdapter,
      },
    ),
  ],
  exports: [LoggingServiceService],
  controllers: [GameServerNodeController],
})
export class GameServerNodeModule {
  constructor(@InjectQueue(GameServerQueues.GameUpdate) queue: Queue) {
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

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MatchServerMiddlewareMiddleware).forRoutes({
      path: "game-server-node/ping/:serverId",
      method: RequestMethod.GET,
    });
  }
}
