import { Module } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { TypeSenseController } from "./type-sense.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { CacheModule } from "../cache/cache.module";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { TypesenseQueues } from "./enums/TypesenseQueues";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { RefreshPlayerJob } from "./jobs/RefreshPlayer";
import { MatchesModule } from "src/matches/matches.module";
import { NotificationsModule } from "src/notifications/notifications.module";
import { SteamMatchHistoryQueues } from "src/steam-match-history/enums/SteamMatchHistoryQueues";
import { RedisModule } from "src/redis/redis.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";
import { PlayerReindexService } from "./player-reindex.service";

@Module({
  imports: [
    HasuraModule,
    CacheModule,
    MatchesModule,
    PostgresModule,
    NotificationsModule,
    RedisModule,
    BullModule.registerQueue({
      name: TypesenseQueues.TypeSense,
    }),
    BullModule.registerQueue({
      name: TypesenseQueues.PlayerReindex,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.CheckSteamBans,
    }),
    BullBoardModule.forFeature({
      name: TypesenseQueues.TypeSense,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: TypesenseQueues.PlayerReindex,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [TypeSenseService],
  providers: [
    TypeSenseService,
    RefreshPlayerJob,
    RefreshAllPlayersJob,
    PlayerReindexService,
    ...getQueuesProcessors("TypeSense"),
    loggerFactory(),
  ],
  controllers: [TypeSenseController],
})
export class TypeSenseModule {}
