import { Module } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { HasuraModule } from "../hasura/hasura.module";
import { CacheModule } from "../cache/cache.module";
import { DemosModule } from "../demos/demos.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { SteamMatchHistoryController } from "./steam-match-history.controller";
import { SteamMatchHistoryService } from "./steam-match-history.service";
import { SteamGcService } from "./steam-gc.service";
import { MatchImportService } from "./match-import.service";
import { SteamMatchHistoryQueues } from "./enums/SteamMatchHistoryQueues";
import { PollAllSteamMatchHistory } from "./jobs/PollAllSteamMatchHistory";
import { ResolveMatchMetadata } from "./jobs/ResolveMatchMetadata";
import { ParseImportedDemo } from "./jobs/ParseImportedDemo";

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
    BullBoardModule.forFeature({
      name: SteamMatchHistoryQueues.PollAllSteamMatchHistory,
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
    HasuraModule,
    CacheModule,
    DemosModule,
    PostgresModule,
  ],
  providers: [
    SteamMatchHistoryService,
    SteamGcService,
    MatchImportService,
    PollAllSteamMatchHistory,
    ResolveMatchMetadata,
    ParseImportedDemo,
    ...getQueuesProcessors("SteamMatchHistory"),
    loggerFactory(),
  ],
  controllers: [SteamMatchHistoryController],
  exports: [SteamMatchHistoryService, MatchImportService],
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
