import { forwardRef, Module } from "@nestjs/common";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchmakingGateway } from "./matchmaking.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RedisModule } from "src/redis/redis.module";
import { MatchesModule } from "src/matches/matches.module";

@Module({
  imports: [RedisModule, HasuraModule, forwardRef(() => MatchesModule)],
  exports: [MatchmakingGateway],
  providers: [MatchmakingGateway, loggerFactory()],
})
export class MatchMaking {}
