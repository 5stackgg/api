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
import { AuthModule } from "src/auth/auth.module";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { DemoMetadataService } from "./demo-metadata.service";
import { DemoParserService } from "./demo-parser.service";

@Module({
  imports: [
    S3Module,
    AuthModule,
    HasuraModule,
    PostgresModule,
    BullModule.registerQueue({
      name: DemoQueues.Demos,
    }),
    BullBoardModule.forFeature({
      name: DemoQueues.Demos,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [DemosController],
  providers: [
    CleanDemos,
    DemoMetadataService,
    DemoParserService,
    ...getQueuesProcessors("Demos"),
    loggerFactory(),
  ],
  exports: [DemoMetadataService, DemoParserService],
})
export class DemosModule {
  constructor(@InjectQueue(DemoQueues.Demos) cleanDemosQueue: Queue) {
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
