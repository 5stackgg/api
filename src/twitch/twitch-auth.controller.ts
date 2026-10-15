import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { ThrottlerBehindProxyGuard } from "../auth/strategies/ThrottlerBehindProxyGuard";
import { TwitchAccountsService } from "./twitch-accounts.service";

const AUTH_THROTTLE = { default: { limit: 10, ttl: 60 * 1000 } };

// Under /auth so both legs are served from the web domain, which is where the
// Twitch app's redirect URL points.
@Controller("auth/twitch")
export class TwitchAuthController {
  constructor(private readonly accounts: TwitchAccountsService) {}

  @UseGuards(ThrottlerBehindProxyGuard, SteamGuard)
  @Throttle(AUTH_THROTTLE)
  @Get()
  public async link(
    @Req() request: Request,
    @Res() response: Response,
    @Query("redirect") redirect?: unknown,
  ) {
    return response.redirect(
      await this.accounts.startLink(request.user.steam_id, redirect),
    );
  }

  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle(AUTH_THROTTLE)
  @Get("callback")
  public async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return response.redirect(
      await this.accounts.completeLink(request.user?.steam_id, query),
    );
  }
}
