import { Module } from "@nestjs/common";
import { HasuraModule } from "../hasura/hasura.module";
import { ServerGateway } from "../sockets/server.gateway";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { EncryptionModule } from "../encryption/encryption.module";
import { RconModule } from "../rcon/rcon.module";

@Module({
  exports: [],
  imports: [HasuraModule, RedisModule, EncryptionModule, RconModule],
  providers: [ServerGateway, loggerFactory()],
})
export class SocketsModule {}