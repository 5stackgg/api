import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { SteamGuard } from "../../auth/strategies/SteamGuard";
import {
  NOTIFICATION_CHANNELS,
  NotificationChannel,
  isKnownKey,
} from "./notification-categories";
import {
  NotificationPreferencesService,
  QuietHours,
} from "./notification-preferences.service";

@Controller("notifications/preferences")
@UseGuards(SteamGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get("quiet-hours")
  public async getQuietHours(@Req() request: Request) {
    return {
      quietHours: await this.preferences.getQuietHours(request.user.steam_id),
    };
  }

  @Put("quiet-hours")
  public async setQuietHours(
    @Req() request: Request,
    @Body() body: QuietHours,
  ) {
    await this.preferences.setQuietHours(request.user.steam_id, body);

    return { success: true };
  }

  // Declared after quiet-hours so ":channel" doesn't swallow it.
  @Get(":channel")
  public async list(
    @Req() request: Request,
    @Param("channel") channel: string,
  ) {
    return {
      preferences: await this.preferences.list(
        request.user.steam_id,
        this.assertChannel(channel),
      ),
    };
  }

  @Put(":channel/:key")
  public async set(
    @Req() request: Request,
    @Param("channel") channel: string,
    @Param("key") key: string,
    @Body() body: { enabled: boolean },
  ) {
    await this.preferences.set(
      request.user.steam_id,
      this.assertChannel(channel),
      this.assertKey(channel, key),
      Boolean(body?.enabled),
    );

    return { success: true };
  }

  @Delete(":channel/:key")
  public async reset(
    @Req() request: Request,
    @Param("channel") channel: string,
    @Param("key") key: string,
  ) {
    await this.preferences.reset(
      request.user.steam_id,
      this.assertChannel(channel),
      this.assertKey(channel, key),
    );

    return { success: true };
  }

  private assertChannel(channel: string): NotificationChannel {
    if (!NOTIFICATION_CHANNELS.includes(channel as NotificationChannel)) {
      throw new BadRequestException(`unknown channel: ${channel}`);
    }

    return channel as NotificationChannel;
  }

  // Without this the table happily accumulates rows for keys nothing will ever
  // read again.
  private assertKey(channel: string, key: string): string {
    if (!isKnownKey(channel as NotificationChannel, key)) {
      throw new BadRequestException(`unknown ${channel} preference: ${key}`);
    }

    return key;
  }
}
