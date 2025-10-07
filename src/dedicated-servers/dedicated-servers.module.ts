import { Module } from "@nestjs/common";
import { DedicatedServersService } from "./dedicated-servers.service";
import { DedicatedServersController } from "./dedicated-servers.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { EncryptionModule } from "src/encryption/encryption.module";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { DedicatedServerQueues } from "./enums/DedicatedServerQueues";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { PingDedicatedServers } from "./jobs/PingDedicatedServers";
import { Queue } from "bullmq";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { SystemModule } from "src/system/system.module";

@Module({
  imports: [
    BullModule.registerQueue({
      name: DedicatedServerQueues.PingDedicatedServers,
    }),
    BullBoardModule.forFeature({
      name: DedicatedServerQueues.PingDedicatedServers,
      adapter: BullMQAdapter,
    }),
    HasuraModule,
    EncryptionModule,
    RconModule,
    RedisModule,
    SystemModule,
  ],
  providers: [
    DedicatedServersService,
    PingDedicatedServers,
    ...getQueuesProcessors("DedicatedServers"),
    loggerFactory(),
  ],
  controllers: [DedicatedServersController],
})
export class DedicatedServersModule {
  constructor(
    @InjectQueue(DedicatedServerQueues.PingDedicatedServers)
    queue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      PingDedicatedServers.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );
  }
}
