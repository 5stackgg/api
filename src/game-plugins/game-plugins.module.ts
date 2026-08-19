import { Logger, Module } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HasuraModule } from "../hasura/hasura.module";
import { CacheModule } from "../cache/cache.module";
import { PostgresModule } from "../postgres/postgres.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PluginRuntimeModule } from "../plugin-runtime/plugin-runtime.module";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";
import { GamePluginQueues } from "./enums/GamePluginQueues";
import { GamePluginsService } from "./game-plugins.service";
import { GameModesService } from "./game-modes.service";
import { GamePluginsController } from "./game-plugins.controller";
import { SyncGamePluginRegistry } from "./jobs/SyncGamePluginRegistry";
import { CheckGamePluginUpdates } from "./jobs/CheckGamePluginUpdates";

@Module({
  providers: [
    GamePluginsService,
    GameModesService,
    SyncGamePluginRegistry,
    CheckGamePluginUpdates,
    ...getQueuesProcessors("GamePlugins"),
    loggerFactory(),
    Logger,
  ],
  imports: [
    HasuraModule,
    CacheModule,
    PostgresModule,
    NotificationsModule,
    PluginRuntimeModule,
    BullModule.registerQueue(
      { name: GamePluginQueues.Registry },
    ),
    BullBoardModule.forFeature(
      { name: GamePluginQueues.Registry, adapter: BullMQAdapter },
    ),
  ],
  exports: [GamePluginsService, GameModesService],
  controllers: [GamePluginsController],
})
export class GamePluginsModule {
  constructor(
    @InjectQueue(GamePluginQueues.Registry) registry: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void registry.add(
      SyncGamePluginRegistry.name,
      {},
      { repeat: { pattern: "*/30 * * * *" } },
    );

    void registry.add(
      CheckGamePluginUpdates.name,
      {},
      { repeat: { pattern: "7 * * * *" } },
    );

  }
}
