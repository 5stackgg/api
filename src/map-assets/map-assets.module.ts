import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { PostgresModule } from "../postgres/postgres.module";
import { K8sModule } from "../k8s/k8s.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MapAssetsQueues } from "./enums/MapAssetsQueues";
import { UtilityQueues } from "../utility/enums/UtilityQueues";
import { MapAssetsService } from "./map-assets.service";
import { BuildMapAssets } from "./jobs/BuildMapAssets";

@Module({
  imports: [
    PostgresModule,
    K8sModule,
    NotificationsModule,
    BullModule.registerQueue(
      {
        name: MapAssetsQueues.BuildMapAssets,
      },
      {
        name: UtilityQueues.UtilityMeta,
      },
    ),
    BullBoardModule.forFeature({
      name: MapAssetsQueues.BuildMapAssets,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    MapAssetsService,
    BuildMapAssets,
    ...getQueuesProcessors("MapAssets"),
    loggerFactory(),
  ],
  exports: [MapAssetsService],
})
export class MapAssetsModule {}
