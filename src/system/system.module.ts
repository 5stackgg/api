import { Module } from "@nestjs/common";
import { SystemService } from "./system.service";
import { SystemController } from "./system.controller";
import { SystemQueues } from "./enums/SystemQueues";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { CheckSystemUpdateJob } from "./jobs/CheckSystemUpdateJob";
import { Queue } from "bullmq";
import { CacheModule } from "src/cache/cache.module";
import { HasuraModule } from "src/hasura/hasura.module";
import { SystemGateway } from "./system.gateway.ts";
import { GameServerNodeModule } from "src/game-server-node/game-server-node.module";
import { NotificationsModule } from "src/notifications/notifications.module";
import { S3Module } from "src/s3/s3.module";

@Module({
  imports: [
    CacheModule,
    HasuraModule,
    GameServerNodeModule,
    NotificationsModule,
    S3Module,
    BullModule.registerQueue({
      name: SystemQueues.Version,
    }),
    BullBoardModule.forFeature({
      name: SystemQueues.Version,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [SystemService],
  providers: [
    SystemGateway,
    SystemService,
    CheckSystemUpdateJob,
    ...getQueuesProcessors("System"),
    loggerFactory(),
  ],
  controllers: [SystemController],
})
export class SystemModule {
  constructor(@InjectQueue(SystemQueues.Version) queue: Queue) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      CheckSystemUpdateJob.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );
  }
}
