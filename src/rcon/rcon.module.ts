import { Module } from "@nestjs/common";
import { RconService } from "./rcon.service";
import { RconGateway } from "./rcon.gateway";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { EncryptionModule } from "../encryption/encryption.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TypeSenseModule } from "../type-sense/type-sense.module";
import { RedisModule } from "../redis/redis.module";
import { CacheModule } from "../cache/cache.module";

@Module({
  imports: [
    HasuraModule,
    EncryptionModule,
    NotificationsModule,
    TypeSenseModule,
    RedisModule,
    CacheModule,
  ],
  exports: [RconService],
  providers: [RconGateway, RconService, loggerFactory()],
})
export class RconModule {}
