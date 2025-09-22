import { Module } from "@nestjs/common";
import { PostgresService } from "./postgres.service";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { PostgresQueues } from "./enums/PostgresQueues";
import { PostgresAnalyzeJob } from "./jobs/PostgresAnalyzeJob";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { ReindexTables } from "./jobs/ReindexTables";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { RedisModule } from "src/redis/redis.module";

@Module({
  imports: [
    BullModule.registerQueue({
      name: PostgresQueues.Postgres,
    }),
    BullModule.registerFlowProducerAsync({
      name: "reindex",
      imports: [RedisModule],
      inject: [RedisManagerService],
      useFactory: async (redisManagerService: RedisManagerService) => {
        return await new Promise((resolve) => {
          const connection = redisManagerService.getConnection();

          connection.on("ready", () => {
            resolve({
              connection,
              name: "reindex",
            });
          });
        });
      },
    }),
    BullBoardModule.forFeature({
      name: PostgresQueues.Postgres,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [PostgresService],
  providers: [
    PostgresService,
    PostgresAnalyzeJob,
    ReindexTables,
    ...getQueuesProcessors("Postgres"),
    loggerFactory(),
  ],
})
export class PostgresModule {
  constructor(@InjectQueue(PostgresQueues.Postgres) queue: Queue) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      PostgresAnalyzeJob.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );

    void queue.add(
      ReindexTables.name,
      {},
      {
        repeat: {
          pattern: "0 0 * * *",
        },
      },
    );
  }
}
