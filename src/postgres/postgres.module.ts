import { Module } from "@nestjs/common";
import { PostgresService } from "./postgres.service";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { PostgresQueues } from "./enums/PostgresQueues";
import { PostgresAnalyzeJob } from "./jobs/PostgresAnalyzeJob";
import { loggerFactory } from "../utilities/LoggerFactory";
import {
  getQueuesProcessors,
  scheduleJobs,
} from "../utilities/QueueProcessors";
import { ReindexTables } from "./jobs/ReindexTables";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { RedisModule } from "src/redis/redis.module";
import { GetDatabaseBackups } from "./jobs/GetDatabaseBackups";
import { RefreshPlayerEloRatings } from "./jobs/RefreshPlayerEloRatings";
import { S3Module } from "src/s3/s3.module";
import { PostgresController } from "./postgres.controller";
import { TypesenseQueues } from "../type-sense/enums/TypesenseQueues";

@Module({
  imports: [
    S3Module,
    BullModule.registerQueue(
      {
        name: PostgresQueues.Postgres,
      },
      {
        name: TypesenseQueues.PlayerReindex,
      },
    ),
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
    GetDatabaseBackups,
    RefreshPlayerEloRatings,
    ...getQueuesProcessors("Postgres"),
    loggerFactory(),
  ],
  controllers: [PostgresController],
})
export class PostgresModule {
  constructor(@InjectQueue(PostgresQueues.Postgres) queue: Queue) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scheduleJobs(queue, {
      [PostgresAnalyzeJob.name]: { pattern: "0 * * * *" },
      [ReindexTables.name]: { pattern: "0 0 * * 0" },
      [GetDatabaseBackups.name]: { pattern: "0 4 * * *" },
      [RefreshPlayerEloRatings.name]: { every: 60_000 },
    });
  }
}
