import { Module } from "@nestjs/common";
import { RconService } from "./rcon.service";
import { HasuraModule } from "../hasura/hasura.module";
import { ServerGateway } from "./server/server.gateway";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, RedisModule],
  exports: [RconService],
  providers: [ServerGateway, RconService, loggerFactory()],
})
export class RconModule {}
