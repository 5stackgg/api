import { Module, forwardRef, OnModuleInit } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { ChatService } from "./chat.service";
import { ChatGateway } from "./chat.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { ChatController } from "./chat.controller";
import { NotificationsModule } from "src/notifications/notifications.module";
import { ChatQueues } from "./enums/ChatQueues";
import { PruneDirectMessages } from "./jobs/PruneDirectMessages";
import { BackfillDirectMessages } from "./jobs/BackfillDirectMessages";

@Module({
  imports: [
    HasuraModule,
    RedisModule,
    PostgresModule,
    forwardRef(() => RconModule),
    NotificationsModule,
    BullModule.registerQueue({
      name: ChatQueues.ChatMaintenance,
    }),
    BullBoardModule.forFeature({
      name: ChatQueues.ChatMaintenance,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    ChatService,
    ChatGateway,
    PruneDirectMessages,
    BackfillDirectMessages,
    ...getQueuesProcessors("Chat"),
    loggerFactory(),
  ],
  exports: [ChatService],
  controllers: [ChatController],
})
export class ChatModule implements OnModuleInit {
  constructor(
    @InjectQueue(ChatQueues.ChatMaintenance)
    private readonly maintenanceQueue: Queue,
  ) {}

  public onModuleInit() {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    // Once, on the first boot that has it. The job itself is what decides
    // whether it has already run.
    void this.maintenanceQueue.add(
      BackfillDirectMessages.name,
      {},
      {
        jobId: BackfillDirectMessages.name,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 3600 },
      },
    );

    void this.maintenanceQueue.add(
      PruneDirectMessages.name,
      {},
      {
        repeat: {
          // Retention is measured in days; sweeping hourly is already far more
          // often than the boundary it is enforcing moves.
          pattern: "17 * * * *",
        },
      },
    );
  }
}
