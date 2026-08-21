import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { CacheModule } from "../cache/cache.module";
import { S3Module } from "../s3/s3.module";
import { AuthModule } from "../auth/auth.module";
import { MatchesModule } from "../matches/matches.module";
import { DemosModule } from "../demos/demos.module";
import { RconModule } from "../rcon/rcon.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { UtilityJobs } from "./enums/UtilityJobs";
import { UtilityQueues } from "./enums/UtilityQueues";
import { UtilityAnalysisController } from "./utility-analysis.controller";
import { UtilityAnalysisService } from "./utility-analysis.service";
import { UtilityArtifactsService } from "./utility-artifacts.service";
import { UtilityDriftService } from "./utility-drift.service";
import { UtilityImportService } from "./utility-import.service";
import { UtilitySeedService } from "./utility-seed.service";
import { UtilityInsightsController } from "./utility-insights.controller";
import { UtilityInsightsService } from "./utility-insights.service";
import { UtilityRepairService } from "./utility-repair.service";
import { UtilitySolverService } from "./utility-solver.service";
import { UtilityLineupsController } from "./utility-lineups.controller";
import { UtilityLineupsService } from "./utility-lineups.service";
import { UtilityMetaService } from "./utility-meta.service";
import { UtilityMiningController } from "./utility-mining.controller";
import { UtilityMiningService } from "./utility-mining.service";
import { UtilityPlaybooksController } from "./utility-playbooks.controller";
import { UtilityPlaybooksService } from "./utility-playbooks.service";
import { UtilityPluginKeyGuard } from "./utility-plugin-key.guard";
import { UtilityPracticeController } from "./utility-practice.controller";
import { UtilityPracticeModeService } from "./utility-practice-mode.service";
import { UtilityPracticeService } from "./utility-practice.service";
import { UtilityRendersController } from "./utility-renders.controller";
import { UtilityRendersService } from "./utility-renders.service";
import { UtilityController } from "./utility.controller";
import { MineUtilityMeta } from "./jobs/MineUtilityMeta";
import { ReapIdleUtilityPracticeSessions } from "./jobs/ReapIdleUtilityPracticeSessions";
import { RunUtilityDriftScan } from "./jobs/RunUtilityDriftScan";
import {
  BatchUtilityRenderJob,
  BatchUtilityRenderJobEvents,
} from "./jobs/BatchUtilityRenderJob";
import { GameStreamerModule } from "../matches/game-streamer/game-streamer.module";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    CacheModule,
    S3Module,
    ConfigModule,
    AuthModule,
    forwardRef(() => MatchesModule),
    forwardRef(() => GameStreamerModule),
    DemosModule,
    NotificationsModule,
    forwardRef(() => RconModule),
    BullModule.registerQueue({
      name: UtilityQueues.UtilityPractice,
    }),
    BullModule.registerQueue({
      name: UtilityQueues.UtilityMeta,
    }),
    BullModule.registerQueue({
      name: UtilityQueues.UtilityDrift,
    }),
    BullModule.registerQueue({
      name: UtilityQueues.UtilityRenders,
    }),
    BullBoardModule.forFeature({
      name: UtilityQueues.UtilityPractice,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: UtilityQueues.UtilityMeta,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: UtilityQueues.UtilityDrift,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: UtilityQueues.UtilityRenders,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    UtilityAnalysisService,
    UtilityArtifactsService,
    UtilityDriftService,
    UtilityImportService,
    UtilityInsightsService,
    UtilityRepairService,
    UtilitySolverService,
    UtilityLineupsService,
    UtilityMetaService,
    UtilityMiningService,
    UtilityPlaybooksService,
    UtilityPracticeModeService,
    UtilityPracticeService,
    UtilityRendersService,
    BatchUtilityRenderJob,
    BatchUtilityRenderJobEvents,
    UtilitySeedService,
    UtilityPluginKeyGuard,
    ReapIdleUtilityPracticeSessions,
    MineUtilityMeta,
    RunUtilityDriftScan,
    ...getQueuesProcessors("Utility"),
    loggerFactory(),
  ],
  controllers: [
    UtilityPracticeController,
    UtilityLineupsController,
    UtilityPlaybooksController,
    UtilityMiningController,
    UtilityAnalysisController,
    UtilityInsightsController,
    UtilityRendersController,
    UtilityController,
  ],
  exports: [
    UtilityPracticeService,
    UtilityRendersService,
    UtilityLineupsService,
    UtilityPlaybooksService,
    UtilityMetaService,
    UtilityMiningService,
    UtilityAnalysisService,
    UtilityDriftService,
    UtilityImportService,
    UtilityInsightsService,
    UtilityRepairService,
    UtilitySolverService,
  ],
})
export class UtilityModule {
  constructor(
    @InjectQueue(UtilityQueues.UtilityPractice) utilityPracticeQueue: Queue,
    @InjectQueue(UtilityQueues.UtilityMeta) utilityMetaQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void utilityPracticeQueue.add(
      UtilityJobs.ReapIdleUtilityPracticeSessions,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void utilityMetaQueue.add(
      UtilityJobs.MineUtilityMeta,
      {},
      {
        repeat: {
          pattern: "17 * * * *",
        },
      },
    );
  }
}
