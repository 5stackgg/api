import { Module } from "@nestjs/common";
import { TelemetryController } from "./telemetry.controller";
import { TelemetryService } from "./telemetry.service";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { TelemetryQueues } from "./enums/TelemetryQueues";
import { SendBasicTelemetry } from "./jobs/SendBasicTelemetry";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { RedisModule } from "src/redis/redis.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { SystemModule } from "src/system/system.module";
import { CacheModule } from "src/cache/cache.module";

@Module({
  imports: [
    RedisModule,
    HasuraModule,
    PostgresModule,
    SystemModule,
    CacheModule,
    BullModule.registerQueue({
      name: TelemetryQueues.Telemetry,
    }),
    BullBoardModule.forFeature({
      name: TelemetryQueues.Telemetry,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    SendBasicTelemetry,
    ...getQueuesProcessors("Telemetry"),
    loggerFactory(),
  ],
  exports: [TelemetryService],
})
export class TelemetryModule {
  constructor(@InjectQueue(TelemetryQueues.Telemetry) queue: Queue) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      SendBasicTelemetry.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );
  }
}
