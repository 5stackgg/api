import { Module } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { ClipsService } from "./clips.service";
import { ClipRendersController } from "./clip-renders.controller";
import { ClipDownloadController } from "./clip-download.controller";
import { ClipViewsController } from "./clip-views.controller";
import { HasuraModule } from "../../hasura/hasura.module";
import { PostgresModule } from "../../postgres/postgres.module";
import { S3Module } from "../../s3/s3.module";
import { GameStreamerModule } from "../game-streamer/game-streamer.module";
import { RedisModule } from "../../redis/redis.module";
import { MatchQueues } from "../enums/MatchQueues";
import { loggerFactory } from "../../utilities/LoggerFactory";
import { getQueuesProcessors } from "../../utilities/QueueProcessors";
import { CleanClips } from "./jobs/CleanClips";
import {
  BatchHighlightsRenderJob,
  BatchHighlightsRenderJobEvents,
} from "./jobs/BatchHighlightsRenderJob";
import { ReconcileQueuedHighlights } from "./jobs/ReconcileQueuedHighlights";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    S3Module,
    GameStreamerModule,
    RedisModule,
    BullModule.registerQueue({
      name: MatchQueues.Clips,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 24 * 3600 },
      },
    }),
    BullBoardModule.forFeature({
      name: MatchQueues.Clips,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [
    ClipRendersController,
    ClipDownloadController,
    ClipViewsController,
  ],
  providers: [
    ClipsService,
    BatchHighlightsRenderJob,
    BatchHighlightsRenderJobEvents,
    CleanClips,
    ReconcileQueuedHighlights,
    ...getQueuesProcessors("Clips"),
    loggerFactory(),
  ],
  exports: [ClipsService],
})
export class ClipsModule {
  constructor(
    @InjectQueue(MatchQueues.Clips) clipsQueue: Queue,
    clipsService: ClipsService,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void clipsQueue.add(
      CleanClips.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );

    void clipsQueue.add(
      ReconcileQueuedHighlights.name,
      {},
      {
        repeat: {
          pattern: "*/5 * * * *",
        },
      },
    );

    void clipsService.reconcileQueuedHighlights().catch(() => {});
  }
}
