import {
  forwardRef,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from "@nestjs/common";
import { MatchesController } from "./matches.controller";
import { MatchAssistantService } from "./match-assistant/match-assistant.service";
import { HasuraModule } from "../hasura/hasura.module";
import { RconModule } from "../rcon/rcon.module";
import { DemosController } from "./demos/demos.controller";
import { BackupRoundsController } from "./backup-rounds/backup-rounds.controller";
import { ServerAuthService } from "./server-auth/server-auth.service";
import { CacheModule } from "../cache/cache.module";
import { RedisModule } from "../redis/redis.module";
import { S3Module } from "../s3/s3.module";
import { DiscordBotModule } from "../discord-bot/discord-bot.module";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { MatchQueues } from "./enums/MatchQueues";
import {
  CheckOnDemandServerJob,
  CheckOnDemandServerJobEvents,
} from "./jobs/CheckOnDemandServerJob";
import { MatchEvents } from "./events";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchServerMiddlewareMiddleware } from "./match-server-middleware/match-server-middleware.middleware";

@Module({
  imports: [
    HasuraModule,
    RconModule,
    CacheModule,
    RedisModule,
    S3Module,
    forwardRef(() => DiscordBotModule),
    BullModule.registerQueue({
      name: MatchQueues.MatchServers,
    }),
    BullBoardModule.forFeature({
      name: MatchQueues.MatchServers,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [MatchesController, DemosController, BackupRoundsController],
  exports: [MatchAssistantService],
  providers: [
    MatchAssistantService,
    ServerAuthService,
    CheckOnDemandServerJob,
    CheckOnDemandServerJobEvents,
    ...Object.values(MatchEvents),
    loggerFactory(),
  ],
})
export class MatchesModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(MatchServerMiddlewareMiddleware)
      .forRoutes(
        { path: "matches/current-match/:serverId", method: RequestMethod.ALL },
        { path: "matches/:matchId/demos/*", method: RequestMethod.POST },
        {
          path: "matches/:matchId/backup-rounds/*",
          method: RequestMethod.POST,
        },
      );
  }
}
