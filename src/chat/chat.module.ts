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
import { PlayerBlocksModule } from "src/player-blocks/player-blocks.module";
import { ChatQueues } from "./enums/ChatQueues";
import { PruneDirectMessages } from "./jobs/PruneDirectMessages";
import { BackfillDirectMessages } from "./jobs/BackfillDirectMessages";
import { RemoveExpiredChatAttachments } from "./jobs/RemoveExpiredChatAttachments";
import { SweepChatAttachments } from "./jobs/SweepChatAttachments";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatGifsService } from "./chat-gifs.service";
import { ChatMediaController } from "./chat-media.controller";
import { S3Module } from "src/s3/s3.module";

@Module({
  imports: [
    HasuraModule,
    RedisModule,
    PostgresModule,
    forwardRef(() => RconModule),
    NotificationsModule,
    PlayerBlocksModule,
    S3Module,
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
    ChatAttachmentsService,
    ChatGifsService,
    PruneDirectMessages,
    BackfillDirectMessages,
    RemoveExpiredChatAttachments,
    SweepChatAttachments,
    ...getQueuesProcessors("Chat"),
    loggerFactory(),
  ],
  exports: [ChatService],
  controllers: [ChatController, ChatMediaController],
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

    void this.maintenanceQueue.add(
      RemoveExpiredChatAttachments.name,
      {},
      {
        repeat: {
          pattern: "*/10 * * * *",
        },
      },
    );

    void this.maintenanceQueue.add(
      SweepChatAttachments.name,
      {},
      {
        repeat: {
          pattern: "41 4 * * *",
        },
      },
    );
  }
}
