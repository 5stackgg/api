import { Module } from "@nestjs/common";
import { DemosController } from "../demos/demos.controller";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { DemoQueues } from "./enums/DemoQueues";
import { loggerFactory } from "../utilities/LoggerFactory";
import { Queue } from "bullmq";
import { CleanDemos } from "./jobs/CleanDemos";
import { S3Module } from "src/s3/s3.module";
import { HasuraModule } from "src/hasura/hasura.module";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";

@Module({
  imports: [
    S3Module,
    HasuraModule,
    BullModule.registerQueue({
      name: DemoQueues.CleanDemos,
    }),
    BullBoardModule.forFeature({
      name: DemoQueues.CleanDemos,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [DemosController],
  providers: [CleanDemos, ...getQueuesProcessors("Demos"), loggerFactory()],
})
export class DemosModule {
  constructor(@InjectQueue(DemoQueues.CleanDemos) cleanDemosQueue: Queue) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void cleanDemosQueue.add(
      CleanDemos.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );
  }
}
