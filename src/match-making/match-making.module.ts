import { forwardRef, Module } from "@nestjs/common";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchMakingGateway } from "./match-making.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RedisModule } from "src/redis/redis.module";
import { MatchesModule } from "src/matches/matches.module";

@Module({
  imports: [RedisModule, HasuraModule, forwardRef(() => MatchesModule)],
  exports: [MatchMakingGateway],
  providers: [MatchMakingGateway, loggerFactory()],
})
export class MatchMakingModule {}
