import { Module } from "@nestjs/common";
import { SocketsGateway } from "./sockets.gateway";
import { loggerFactory } from "../utilities/LoggerFactory";
import { RedisModule } from "src/redis/redis.module";
import { MatchMaking } from "src/matchmaking/matchmaking.module";
import { HasuraModule } from "src/hasura/hasura.module";

@Module({
  exports: [],
  imports: [RedisModule, MatchMaking, HasuraModule],
  providers: [SocketsGateway, loggerFactory()],
})
export class SocketsModule {
  constructor() {}
}
