import { Module } from "@nestjs/common";
import { DedicatedServersService } from "./dedicated-servers.service";
import { DedicatedServerConfigService } from "./dedicated-server-config.service";
import { ServerAccessService } from "./server-access.service";
import { DedicatedServersController } from "./dedicated-servers.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { EncryptionModule } from "src/encryption/encryption.module";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { DedicatedServerQueues } from "./enums/DedicatedServerQueues";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { PingDedicatedServers } from "./jobs/PingDedicatedServers";
import { Queue } from "bullmq";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { SystemModule } from "src/system/system.module";
import { PluginRuntimeModule } from "src/plugin-runtime/plugin-runtime.module";
import { GamePluginsModule } from "../game-plugins/game-plugins.module";
import { PostgresModule } from "../postgres/postgres.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CacheModule } from "../cache/cache.module";
import { FileManagerModule } from "../file-manager/file-manager.module";
import { DedicatedServerMigrationService } from "./dedicated-server-migration.service";
import { MigrateDedicatedServer } from "./jobs/MigrateDedicatedServer";
import { SweepServerMigrations } from "./jobs/SweepServerMigrations";
import { CleanupDedicatedServerFiles } from "./jobs/CleanupDedicatedServerFiles";

@Module({
  imports: [
    BullModule.registerQueue({
      name: DedicatedServerQueues.PingDedicatedServers,
    }),
    BullModule.registerQueue({
      name: DedicatedServerQueues.ServerMigrations,
    }),
    BullModule.registerQueue({
      name: DedicatedServerQueues.ServerMaintenance,
    }),
    BullBoardModule.forFeature({
      name: DedicatedServerQueues.PingDedicatedServers,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: DedicatedServerQueues.ServerMigrations,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: DedicatedServerQueues.ServerMaintenance,
      adapter: BullMQAdapter,
    }),
    HasuraModule,
    EncryptionModule,
    RconModule,
    RedisModule,
    SystemModule,
    PluginRuntimeModule,
    GamePluginsModule,
    PostgresModule,
    NotificationsModule,
    CacheModule,
    FileManagerModule,
  ],
  providers: [
    DedicatedServersService,
    DedicatedServerConfigService,
    ServerAccessService,
    DedicatedServerMigrationService,
    PingDedicatedServers,
    MigrateDedicatedServer,
    SweepServerMigrations,
    CleanupDedicatedServerFiles,
    ...getQueuesProcessors("DedicatedServers"),
    loggerFactory(),
  ],
  exports: [DedicatedServersService, ServerAccessService],
  controllers: [DedicatedServersController],
})
export class DedicatedServersModule {
  constructor(
    @InjectQueue(DedicatedServerQueues.PingDedicatedServers)
    queue: Queue,
    @InjectQueue(DedicatedServerQueues.ServerMaintenance)
    maintenanceQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      PingDedicatedServers.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void maintenanceQueue.add(
      SweepServerMigrations.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );
  }
}
