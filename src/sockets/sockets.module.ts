import { forwardRef, Module } from "@nestjs/common";
import { ServerGateway } from "../sockets/server.gateway";
import { loggerFactory } from "../utilities/LoggerFactory";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { MatchesModule } from "src/matches/matches.module";
import { MatchMakingModule } from "src/match-making/match-making.module";
import { CacheModule } from "src/cache/cache.module";

@Module({
  exports: [],
  imports: [
    RconModule,
    RedisModule,
    // CacheModule,
    forwardRef(() => MatchesModule),
    forwardRef(() => MatchMakingModule),
  ],
  providers: [ServerGateway, loggerFactory()],
})
export class SocketsModule {}
