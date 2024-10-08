import { forwardRef, Module } from "@nestjs/common";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchMakingService } from "./match-making.servcie";
import { HasuraModule } from "src/hasura/hasura.module";
import { RedisModule } from "src/redis/redis.module";
import { MatchesModule } from "src/matches/matches.module";

@Module({
  imports: [RedisModule, HasuraModule, forwardRef(() => MatchesModule)],
  exports: [MatchMakingService],
  providers: [MatchMakingService, loggerFactory()],
})
export class MatchMakingModule {}
