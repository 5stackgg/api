import { forwardRef, Module } from "@nestjs/common";
import { SocketsGateway } from "./sockets.gateway";
import { loggerFactory } from "../utilities/LoggerFactory";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { MatchesModule } from "src/matches/matches.module";
import { MatchMakingModule } from "src/match-making/match-making.module";

@Module({
  exports: [],
  imports: [
    RconModule,
    RedisModule,
    forwardRef(() => MatchesModule),
    forwardRef(() => MatchMakingModule),
  ],
  providers: [SocketsGateway, loggerFactory()],
})
export class SocketsModule {}
