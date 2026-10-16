import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { CacheModule } from "../cache/cache.module";
import { PostgresModule } from "../postgres/postgres.module";
import { S3Module } from "../s3/s3.module";
import { FaceitModule } from "../faceit/faceit.module";
import { SteamMatchHistoryModule } from "../steam-match-history/steam-match-history.module";
import { SteamMatchHistoryQueues } from "../steam-match-history/enums/SteamMatchHistoryQueues";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { ExtensionController } from "./extension.controller";
import { ExtensionService } from "./extension.service";
import { ExtensionQueues } from "./enums/ExtensionQueues";
import { FetchFaceitDemo } from "./jobs/FetchFaceitDemo";

@Module({
  imports: [
    BullModule.registerQueue({
      name: ExtensionQueues.FetchFaceitDemo,
    }),
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.ProcessUploadedDemo,
    }),
    BullBoardModule.forFeature({
      name: ExtensionQueues.FetchFaceitDemo,
      adapter: BullMQAdapter,
    }),
    CacheModule,
    PostgresModule,
    S3Module,
    FaceitModule,
    SteamMatchHistoryModule,
  ],
  controllers: [ExtensionController],
  providers: [
    loggerFactory(),
    ExtensionService,
    FetchFaceitDemo,
    ...getQueuesProcessors("Extension"),
  ],
})
export class ExtensionModule {}
