import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { PostgresModule } from "../postgres/postgres.module";
import { K8sModule } from "../k8s/k8s.module";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MapAssetsQueues } from "./enums/MapAssetsQueues";
import { MapAssetsService } from "./map-assets.service";
import { MapAssetsController } from "./map-assets.controller";
import { BuildMapAssets } from "./jobs/BuildMapAssets";

@Module({
  imports: [
    PostgresModule,
    K8sModule,
    BullModule.registerQueue({
      name: MapAssetsQueues.BuildMapAssets,
    }),
    BullBoardModule.forFeature({
      name: MapAssetsQueues.BuildMapAssets,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [MapAssetsController],
  providers: [
    MapAssetsService,
    BuildMapAssets,
    ...getQueuesProcessors("MapAssets"),
    loggerFactory(),
  ],
  exports: [MapAssetsService],
})
export class MapAssetsModule {}
