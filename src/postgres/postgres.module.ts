import { Module } from "@nestjs/common";
import { PostgresService } from "./postgres.service";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { PostgresQueues } from "./enums/PostgresQueues";
import { PostgresAnalyzeJob } from "./jobs/PostgresAnalyzeJob";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [
    BullModule.registerQueue({
      name: PostgresQueues.Postgres,
    }),
    BullBoardModule.forFeature({
      name: PostgresQueues.Postgres,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [PostgresService],
  providers: [PostgresService, PostgresAnalyzeJob, loggerFactory()],
})
export class PostgresModule {
  constructor(@InjectQueue(PostgresQueues.Postgres) private queue: Queue) {
    void queue.add(
      PostgresAnalyzeJob.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );
  }
}
