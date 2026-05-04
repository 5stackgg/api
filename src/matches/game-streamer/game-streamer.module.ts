import { Module } from "@nestjs/common";
import { GameStreamerService } from "./game-streamer.service";
import { GameStreamerController } from "./game-streamer.controller";
import { DemoSessionsController } from "./demo-sessions.controller";
import { DemoSessionWatcherService } from "./demo-session-watcher.service";
import { DemoSessionWatcherGateway } from "./demo-session-watcher.gateway";
import { HasuraModule } from "../../hasura/hasura.module";
import { EncryptionModule } from "../../encryption/encryption.module";
import { S3Module } from "../../s3/s3.module";
import { loggerFactory } from "../../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, EncryptionModule, S3Module],
  controllers: [GameStreamerController, DemoSessionsController],
  providers: [
    GameStreamerService,
    DemoSessionWatcherService,
    DemoSessionWatcherGateway,
    loggerFactory(),
  ],
  exports: [GameStreamerService, DemoSessionWatcherService],
})
export class GameStreamerModule {}
