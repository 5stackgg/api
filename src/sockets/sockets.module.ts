import { Module } from "@nestjs/common";
import { SocketsGateway } from "./sockets.gateway";
import { loggerFactory } from "../utilities/LoggerFactory";
import { RedisModule } from "src/redis/redis.module";
import { MatchMaking } from "src/matchmaking/matchmaking.module";

@Module({
  exports: [],
  imports: [RedisModule, MatchMaking],
  providers: [SocketsGateway, loggerFactory()],
})
export class SocketsModule {
  constructor() {}
}
