import {
  BadRequestException,
  Controller,
  ForbiddenException,
} from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import {
  PresenceAdminStatus,
  SteamPresenceService,
} from "./steam-presence.service";

@Controller("steam-presence")
export class SteamPresenceController {
  constructor(private readonly steamPresence: SteamPresenceService) {}

  // Assigns (or returns the already-assigned) bot a user should add as a friend
  // for instant match imports. steamId/addUrl are null when presence is off or
  // the pool has no online bot with free capacity.
  @HasuraAction()
  public async assignSteamPresenceBot(data: { user: User }): Promise<{
    enabled: boolean;
    steamId: string | null;
    addUrl: string | null;
    status: string | null;
  }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!(await this.steamPresence.isEnabled())) {
      return { enabled: false, steamId: null, addUrl: null, status: null };
    }
    const bot = await this.steamPresence.assignBotForUser(data.user.steam_id);
    return {
      enabled: true,
      steamId: bot?.steamId ?? null,
      addUrl: bot?.addUrl ?? null,
      status: bot?.status ?? null,
    };
  }

  // Admin debug dashboard data: pool totals, per-bot live status, recent events.
  @HasuraAction()
  public async steamPresenceAdminStatus(data: {
    user: User;
  }): Promise<PresenceAdminStatus> {
    this.assertAdmin(data.user);
    return this.steamPresence.getAdminStatus();
  }

  // Add a friends-role bot account to the pool (admin).
  @HasuraAction()
  public async addSteamPresenceBotAccount(data: {
    user: User;
    username?: string;
    bot_secret?: string;
    friend_capacity?: number;
  }): Promise<{ success: boolean }> {
    this.assertAdmin(data.user);
    const username = data.username?.trim();
    const password = data.bot_secret;
    if (!username || !password) {
      throw new BadRequestException("username and bot_secret are required");
    }
    const capacity =
      Number.isFinite(data.friend_capacity) && Number(data.friend_capacity) > 0
        ? Math.min(Number(data.friend_capacity), 2000)
        : undefined;
    await this.steamPresence.addFriendsAccount(username, password, capacity);
    return { success: true };
  }

  // Submit a Steam Guard (2FA) code for a bot account awaiting login (admin).
  @HasuraAction()
  public async submitSteamPresenceSteamGuard(data: {
    user: User;
    account_id?: string;
    code?: string;
  }): Promise<{ success: boolean }> {
    this.assertAdmin(data.user);
    if (!data.account_id) {
      throw new BadRequestException("account_id is required");
    }
    const code = data.code?.trim();
    if (!code) {
      throw new BadRequestException("code is required");
    }
    const result = await this.steamPresence.submitSteamGuard(
      data.account_id,
      code,
    );
    return { success: result.ok };
  }

  // Remove a friends-role bot account (admin).
  @HasuraAction()
  public async removeSteamPresenceBotAccount(data: {
    user: User;
    account_id?: string;
  }): Promise<{ success: boolean }> {
    this.assertAdmin(data.user);
    if (!data.account_id) {
      throw new BadRequestException("account_id is required");
    }
    const result = await this.steamPresence.removeFriendsAccount(
      data.account_id,
    );
    return { success: result.ok };
  }

  private assertAdmin(user?: User): void {
    if (user?.role !== "administrator") {
      throw new ForbiddenException("administrator access required");
    }
  }
}
