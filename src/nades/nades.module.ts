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
import { NadeJobs } from "./enums/NadeJobs";
import { NadeQueues } from "./enums/NadeQueues";
import { NadeAnalysisController } from "./nade-analysis.controller";
import { NadeAnalysisService } from "./nade-analysis.service";
import { NadeArtifactsService } from "./nade-artifacts.service";
import { NadeDriftService } from "./nade-drift.service";
import { NadeImportService } from "./nade-import.service";
import { NadeInsightsController } from "./nade-insights.controller";
import { NadeInsightsService } from "./nade-insights.service";
import { NadeRepairService } from "./nade-repair.service";
import { NadeSolverService } from "./nade-solver.service";
import { NadeLineupsController } from "./nade-lineups.controller";
import { NadeLineupsService } from "./nade-lineups.service";
import { NadeMetaService } from "./nade-meta.service";
import { NadeMiningController } from "./nade-mining.controller";
import { NadeMiningService } from "./nade-mining.service";
import { NadePlaybooksController } from "./nade-playbooks.controller";
import { NadePlaybooksService } from "./nade-playbooks.service";
import { NadePluginKeyGuard } from "./nade-plugin-key.guard";
import { NadePracticeController } from "./nade-practice.controller";
import { NadePracticeModeService } from "./nade-practice-mode.service";
import { NadePracticeService } from "./nade-practice.service";
import { NadesController } from "./nades.controller";
import { MineNadeMeta } from "./jobs/MineNadeMeta";
import { ReapIdleNadePracticeSessions } from "./jobs/ReapIdleNadePracticeSessions";
import { RunNadeDriftScan } from "./jobs/RunNadeDriftScan";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    CacheModule,
    S3Module,
    ConfigModule,
    AuthModule,
    forwardRef(() => MatchesModule),
    DemosModule,
    NotificationsModule,
    forwardRef(() => RconModule),
    BullModule.registerQueue({
      name: NadeQueues.NadePractice,
    }),
    BullModule.registerQueue({
      name: NadeQueues.NadeMeta,
    }),
    BullModule.registerQueue({
      name: NadeQueues.NadeDrift,
    }),
    BullBoardModule.forFeature({
      name: NadeQueues.NadePractice,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: NadeQueues.NadeMeta,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: NadeQueues.NadeDrift,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    NadeAnalysisService,
    NadeArtifactsService,
    NadeDriftService,
    NadeImportService,
    NadeInsightsService,
    NadeRepairService,
    NadeSolverService,
    NadeLineupsService,
    NadeMetaService,
    NadeMiningService,
    NadePlaybooksService,
    NadePracticeModeService,
    NadePracticeService,
    NadePluginKeyGuard,
    ReapIdleNadePracticeSessions,
    MineNadeMeta,
    RunNadeDriftScan,
    ...getQueuesProcessors("Nades"),
    loggerFactory(),
  ],
  controllers: [
    NadePracticeController,
    NadeLineupsController,
    NadePlaybooksController,
    NadeMiningController,
    NadeAnalysisController,
    NadeInsightsController,
    NadesController,
  ],
  exports: [
    NadePracticeService,
    NadeLineupsService,
    NadePlaybooksService,
    NadeMetaService,
    NadeMiningService,
    NadeAnalysisService,
    NadeDriftService,
    NadeImportService,
    NadeInsightsService,
    NadeRepairService,
    NadeSolverService,
  ],
})
export class NadesModule {
  constructor(
    @InjectQueue(NadeQueues.NadePractice) nadePracticeQueue: Queue,
    @InjectQueue(NadeQueues.NadeMeta) nadeMetaQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void nadePracticeQueue.add(
      NadeJobs.ReapIdleNadePracticeSessions,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void nadeMetaQueue.add(
      NadeJobs.MineNadeMeta,
      {},
      {
        repeat: {
          pattern: "17 * * * *",
        },
      },
    );
  }
}
