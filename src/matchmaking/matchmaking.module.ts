import { forwardRef, Module } from "@nestjs/common";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchmakingGateway } from "./matchmaking.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RedisModule } from "src/redis/redis.module";
import { MatchesModule } from "src/matches/matches.module";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";

@Module({
  imports: [RedisModule, HasuraModule, forwardRef(() => MatchesModule)],
  exports: [MatchmakeService, MatchmakingLobbyService],
  providers: [
    MatchmakingGateway,
    MatchmakeService,
    MatchmakingLobbyService,
    loggerFactory(),
  ],
})
export class MatchMaking {}
