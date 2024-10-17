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

@Module({
  imports: [
    CacheModule,
    BullModule.registerQueue({
      name: SystemQueues.Version,
    }),
    BullBoardModule.forFeature({
      name: SystemQueues.Version,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    SystemService,
    CheckSystemUpdateJob,
    ...getQueuesProcessors("System"),
    loggerFactory(),
  ],
  controllers: [SystemController],
})
export class SystemModule {
  constructor(@InjectQueue(SystemQueues.Version) private queue: Queue) {
    void queue.add(
      CheckSystemUpdateJob.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );
  }
}
