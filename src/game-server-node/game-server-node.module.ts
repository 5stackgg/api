import {
  Logger,
  MiddlewareConsumer,
  Module,
  OnApplicationBootstrap,
  RequestMethod,
} from "@nestjs/common";
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
import { MarkDedicatedServerOffline } from "./jobs/MarkDedicatedServerOffline";
import { LoggingServiceService } from "./logging-service/logging-service.service";
import { RedisModule } from "src/redis/redis.module";
import { NotificationsModule } from "src/notifications/notifications.module";
import { RconModule } from "src/rcon/rcon.module";
import { CheckServerPluginVersions } from "./jobs/CheckServerPluginVersions";
import { HasuraService } from "src/hasura/hasura.service";
import { GetPluginVersions } from "./jobs/GetPluginVersions";

@Module({
  providers: [
    GameServerNodeService,
    GameServerNodeGateway,
    CheckGameUpdate,
    GetPluginVersions,
    MarkGameServerNodeOffline,
    MarkDedicatedServerOffline,
    CheckServerPluginVersions,
    ...getQueuesProcessors("GameServerNode"),
    loggerFactory(),
    LoggingServiceService,
  ],
  imports: [
    RedisModule,
    TailscaleModule,
    HasuraModule,
    CacheModule,
    NotificationsModule,
    RconModule,
    BullModule.registerQueue(
      {
        name: GameServerQueues.GameUpdate,
      },
      {
        name: GameServerQueues.NodeOffline,
      },
      {
        name: GameServerQueues.PluginVersion,
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
      {
        name: GameServerQueues.PluginVersion,
        adapter: BullMQAdapter,
      },
    ),
  ],
  exports: [LoggingServiceService],
  controllers: [GameServerNodeController],
})
export class GameServerNodeModule implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(GameServerQueues.GameUpdate) queue: Queue,
    private readonly hasura: HasuraService,
    private readonly gameServerNodeService: GameServerNodeService,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      CheckGameUpdate.name,
      {},
      {
        repeat: {
          pattern: "*/6 * * * *",
        },
      },
    );

    void queue.add(
      GetPluginVersions.name,
      {},
      {
        repeat: {
          pattern: "*/5 * * * *",
        },
      },
    );

    void queue.add(
      CheckServerPluginVersions.name,
      {},
      {
        repeat: {
          pattern: "*/5 * * * *",
        },
      },
    );
  }

  public async onApplicationBootstrap() {
    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            status: {
              _eq: "Online",
            },
          },
        },
        id: true,
      },
    });

    for (const node of game_server_nodes) {
      void this.gameServerNodeService.moitorUpdateStatus(node.id);
    }
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MatchServerMiddlewareMiddleware).forRoutes({
      path: "game-server-node/ping/:serverId",
      method: RequestMethod.GET,
    });
  }
}
