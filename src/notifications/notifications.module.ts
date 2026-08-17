import { Module, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { NotificationsService } from "./notifications.service";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { NotificationsQueues } from "./enums/NotificationsQueues";
import { SendSanctionNotifications } from "./jobs/SendSanctionNotifications";
import { SendPushBroadcast } from "./jobs/SendPushBroadcast";
import { SendPushDelivery } from "./jobs/SendPushDelivery";
import { PushNotificationsService } from "./push/push-notifications.service";
import { PushNotificationsController } from "./push/push-notifications.controller";
import { NotificationPreferencesService } from "./preferences/notification-preferences.service";
import { NotificationPreferencesController } from "./preferences/notification-preferences.controller";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    ConfigModule,
    RedisModule,
    BullModule.registerQueue({
      name: NotificationsQueues.SanctionNotifications,
    }),
    BullBoardModule.forFeature({
      name: NotificationsQueues.SanctionNotifications,
      adapter: BullMQAdapter,
    }),
    BullModule.registerQueue({
      name: NotificationsQueues.PushBroadcast,
    }),
    BullBoardModule.forFeature({
      name: NotificationsQueues.PushBroadcast,
      adapter: BullMQAdapter,
    }),
    BullModule.registerQueue({
      name: NotificationsQueues.PushDelivery,
    }),
    BullBoardModule.forFeature({
      name: NotificationsQueues.PushDelivery,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [PushNotificationsController, NotificationPreferencesController],
  providers: [
    NotificationsService,
    PushNotificationsService,
    NotificationPreferencesService,
    SendSanctionNotifications,
    SendPushBroadcast,
    SendPushDelivery,
    ...getQueuesProcessors("Notifications"),
    loggerFactory(),
  ],
  exports: [
    NotificationsService,
    PushNotificationsService,
    NotificationPreferencesService,
  ],
})
export class NotificationsModule implements OnModuleInit {
  constructor(private readonly pushNotifications: PushNotificationsService) {}

  public async onModuleInit() {
    // Keys can live in `settings`, so they aren't known at construction.
    await this.pushNotifications.loadKeys();
  }
}
