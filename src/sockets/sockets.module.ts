import { Module } from "@nestjs/common";
import { SocketsGateway } from "./sockets.gateway";
import { loggerFactory } from "../utilities/LoggerFactory";
import { RedisModule } from "src/redis/redis.module";
import { MatchMakingModule } from "src/match-making/match-making.module";

@Module({
  exports: [],
  imports: [RedisModule, MatchMakingModule],
  providers: [SocketsGateway, loggerFactory()],
})
export class SocketsModule {}
