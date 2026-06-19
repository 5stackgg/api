import { Module, forwardRef } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { HasuraModule } from "../hasura/hasura.module";
import { RedisModule } from "../redis/redis.module";
import { CacheModule } from "../cache/cache.module";
import { DemosModule } from "../demos/demos.module";
import { S3Module } from "../s3/s3.module";
import { ClipsModule } from "../matches/clips/clips.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { FaceitModule } from "../faceit/faceit.module";
import { SteamMatchHistoryController } from "./steam-match-history.controller";
import { SteamMatchHistoryService } from "./steam-match-history.service";
import { SteamBansService } from "./steam-bans.service";
import { SteamGcService } from "./steam-gc.service";
import { MatchImportService } from "./match-import.service";
import { SteamMatchHistoryQueues } from "./enums/SteamMatchHistoryQueues";
import { PollAllSteamMatchHistory } from "./jobs/PollAllSteamMatchHistory";
import { CheckSteamBansForMatch } from "./jobs/CheckSteamBansForMatch";
import { DrainSteamBans } from "./jobs/DrainSteamBans";
import { PollSteamMatchHistoryForUser } from "./jobs/PollSteamMatchHistoryForUser";
import { ResolveMatchMetadata } from "./jobs/ResolveMatchMetadata";
import { ParseImportedDemo } from "./jobs/ParseImportedDemo";
import { ProcessUploadedDemo } from "./jobs/ProcessUploadedDemo";

@Module({
  imports: [
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.PollAllSteamMatchHistory,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.ResolveMatchMetadata,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.ParseImportedDemo,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.ProcessUploadedDemo,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.CheckSteamBansForMatch,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.CheckSteamBans,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.PollSteamMatchHistoryForUser,
    }),
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.PollAllSteamMatchHistory,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.CheckSteamBansForMatch,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.CheckSteamBans,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.PollSteamMatchHistoryForUser,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.ResolveMatchMetadata,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.ParseImportedDemo,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.ProcessUploadedDemo,
      adapter: BullMQAdapter,
    }),
    HasuraModule,
    RedisModule,
    CacheModule,
    DemosModule,
    S3Module,
    ClipsModule,
    PostgresModule,
    forwardRef(() => FaceitModule),
  ],
  providers: [
    SteamMatchHistoryService,
    SteamBansService,
    SteamGcService,
    MatchImportService,
    PollAllSteamMatchHistory,
    CheckSteamBansForMatch,
    DrainSteamBans,
    PollSteamMatchHistoryForUser,
    ResolveMatchMetadata,
    ParseImportedDemo,
    ProcessUploadedDemo,
    ...getQueuesProcessors("SteamMatchHistory"),
    loggerFactory(),
  ],
  controllers: [SteamMatchHistoryController],
  exports: [SteamMatchHistoryService, SteamBansService, MatchImportService],
})
export class SteamMatchHistoryModule {
  constructor(
    @InjectQueue(SteamMatchHistoryQueues.PollAllSteamMatchHistory)
    queue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      PollAllSteamMatchHistory.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );
  }
}
