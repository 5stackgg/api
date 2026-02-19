import { Module } from "@nestjs/common";
import { LeaderboardController } from "./leaderboard.controller";
import { CacheModule } from "../cache/cache.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [CacheModule, PostgresModule],
  controllers: [LeaderboardController],
  providers: [loggerFactory()],
})
export class LeaderboardModule {}
