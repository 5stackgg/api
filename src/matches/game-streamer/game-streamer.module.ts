import { Module } from "@nestjs/common";
import { GameStreamerService } from "./game-streamer.service";
import { GameStreamerController } from "./game-streamer.controller";
import { CacheModule } from "../../cache/cache.module";
import { HasuraModule } from "../../hasura/hasura.module";
import { EncryptionModule } from "../../encryption/encryption.module";
import { loggerFactory } from "../../utilities/LoggerFactory";

@Module({
  imports: [CacheModule, HasuraModule, EncryptionModule],
  controllers: [GameStreamerController],
  providers: [GameStreamerService, loggerFactory()],
  exports: [GameStreamerService],
})
export class GameStreamerModule {}
