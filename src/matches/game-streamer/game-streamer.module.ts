import { Module } from "@nestjs/common";
import { GameStreamerService } from "./game-streamer.service";
import { SteamAccountService } from "./steam-account.service";
import { GameStreamerController } from "./game-streamer.controller";
import { DemoSessionsController } from "./demo-sessions.controller";
import { GameServerNodeBakeController } from "./game-server-node-bake.controller";
import { HudDataController } from "./hud-data.controller";
import { SnapshotController } from "./snapshot.controller";
import { StreamAccessController } from "./stream-access.controller";
import { StreamAccessService } from "./stream-access.service";
import { DemoSessionWatcherService } from "./demo-session-watcher.service";
import { DemoSessionWatcherGateway } from "./demo-session-watcher.gateway";
import { HasuraModule } from "../../hasura/hasura.module";
import { EncryptionModule } from "../../encryption/encryption.module";
import { PostgresModule } from "../../postgres/postgres.module";
import { S3Module } from "../../s3/s3.module";
import { RedisModule } from "../../redis/redis.module";
import { DemosModule } from "../../demos/demos.module";
import { K8sModule } from "../../k8s/k8s.module";
import { ReleaseChannelModule } from "../../release-channel/release-channel.module";
import { loggerFactory } from "../../utilities/LoggerFactory";

@Module({
  imports: [
    HasuraModule,
    EncryptionModule,
    PostgresModule,
    S3Module,
    RedisModule,
    DemosModule,
    K8sModule,
    ReleaseChannelModule,
  ],
  controllers: [
    GameStreamerController,
    DemoSessionsController,
    GameServerNodeBakeController,
    HudDataController,
    SnapshotController,
    StreamAccessController,
  ],
  providers: [
    GameStreamerService,
    StreamAccessService,
    SteamAccountService,
    DemoSessionWatcherService,
    DemoSessionWatcherGateway,
    loggerFactory(),
  ],
  exports: [
    GameStreamerService,
    SteamAccountService,
    DemoSessionWatcherService,
  ],
})
export class GameStreamerModule {}
