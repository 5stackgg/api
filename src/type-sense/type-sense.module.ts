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
import { PostgresModule } from "../postgres/postgres.module";
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";

@Module({
  imports: [
    HasuraModule,
    CacheModule,
    MatchesModule,
    PostgresModule,
    BullModule.registerQueue({
      name: TypesenseQueues.TypeSense,
    }),
    BullBoardModule.forFeature({
      name: TypesenseQueues.TypeSense,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [TypeSenseService],
  providers: [
    TypeSenseService,
    RefreshPlayerJob,
    RefreshAllPlayersJob,
    ...getQueuesProcessors("TypeSense"),
    loggerFactory(),
  ],
  controllers: [TypeSenseController],
})
export class TypeSenseModule {}
