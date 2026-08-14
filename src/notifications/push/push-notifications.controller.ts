import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Request } from "express";
import { SteamGuard } from "../../auth/strategies/SteamGuard";
import { HasuraAction, HasuraEvent } from "../../hasura/hasura.controller";
import { HasuraEventData } from "../../hasura/types/HasuraEventData";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import {
  PushNotificationsService,
  PushSubscriptionPayload,
} from "./push-notifications.service";

@Controller("notifications/push")
export class PushNotificationsController {
  constructor(
    private readonly pushNotifications: PushNotificationsService,
    @InjectQueue(NotificationsQueues.PushBroadcast)
    private readonly pushBroadcastQueue: Queue,
  ) {}

  @Get("vapid-public-key")
  public getPublicKey() {
    // Null rather than an error when unconfigured, so the frontend can hide
    // the toggle instead of surfacing a 500 at the player.
    return { publicKey: this.pushNotifications.getPublicKey() };
  }

  // Admin-facing setup status for the application settings page. Deliberately
  // never returns the private key.
  @HasuraAction()
  public async webPushStatus() {
    const [subscriptions] = await this.pushNotifications.countSubscriptions();

    return {
      configured: this.pushNotifications.isConfigured(),
      managed_by_environment: this.pushNotifications.isManagedByEnvironment(),
      subscriptions,
    };
  }

  @HasuraAction()
  public async generateWebPushKeys() {
    await this.pushNotifications.generateKeys();

    return { success: true };
  }

  @Post("subscribe")
  @UseGuards(SteamGuard)
  public async subscribe(
    @Req() request: Request,
    @Body() body: { subscription: PushSubscriptionPayload },
  ) {
    await this.pushNotifications.subscribe(
      request.user.steam_id,
      body.subscription,
      request.headers["user-agent"],
    );

    return { success: true };
  }

  @Delete("subscribe")
  @UseGuards(SteamGuard)
  public async unsubscribe(
    @Req() request: Request,
    @Body() body: { endpoint: string },
  ) {
    await this.pushNotifications.unsubscribe(
      request.user.steam_id,
      body.endpoint,
    );

    return { success: true };
  }

  // Hasura event trigger on public.notifications (INSERT only) -- see
  // hasura/metadata/databases/default/tables/public_notifications.yaml.
  //
  // The method name must match the trigger name exactly; the registry in
  // HasuraController is keyed by it, and only searches modules' `controllers`,
  // which is why this lives here rather than on the service.
  @HasuraEvent()
  public async notification_events(
    data: HasuraEventData<{ id: string; type: string; entity_id?: string }>,
  ) {
    if (data.op !== "INSERT") {
      return;
    }

    // Written as part of a fan-out whose author already queued one job for the
    // whole burst. One lookup here replaces two queries and a send per row.
    if (await this.pushNotifications.isFanOutClaimed(data.new.id)) {
      return;
    }

    // A fan-out type inserts one row per player, and this fires per row.
    // The jobId collapses them into a single send.
    if (PushNotificationsService.isBatched(data.new.type)) {
      await this.pushBroadcastQueue.add(
        "PushBroadcast",
        { type: data.new.type, entityId: data.new.entity_id },
        {
          jobId: `push-broadcast.${data.new.type}.${data.new.entity_id}`,
          delay: 5000,
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 3600 },
        },
      );
      return;
    }

    await this.pushNotifications.sendForNotification(data.new);
  }
}
