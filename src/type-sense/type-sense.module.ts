import { forwardRef, Module } from "@nestjs/common";
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

@Module({
  imports: [
    HasuraModule,
    CacheModule,
    MatchesModule,
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
    ...getQueuesProcessors("TypeSense"),
    loggerFactory(),
  ],
  controllers: [TypeSenseController],
})
export class TypeSenseModule {}
