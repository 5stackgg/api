import { Controller, Get, UseGuards, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { SteamGuard } from "./strategies/SteamGuard";
import { HasuraAction } from "../hasura/hasura.controller";
import { DiscordGuard } from "./strategies/DiscordGuard";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../configs/types/AppConfig";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  @UseGuards(SteamGuard)
  @Get("steam")
  public async steamLogin(@Req() request: Request) {
    const { redirect } = request.query;

    request.session.redirect = this.config.get<AppConfig>("app").webDomain;

    if (process.env.DEV && redirect) {
      request.session.redirect = redirect as string;
    }

    return;
  }

  @UseGuards(SteamGuard)
  @Get("steam/callback")
  public steamCallback(@Req() request: Request, @Res() res: Response) {
    // TODO - handle dev redirect
    return res.redirect(request.session.redirect || "/");
  }

  @UseGuards(DiscordGuard)
  @Get("discord")
  public async linkDiscord() {
    return;
  }

  @UseGuards(DiscordGuard)
  @Get("discord/callback")
  public linkDiscordCallback(@Req() request: Request, @Res() res: Response) {
    return res.redirect("/");
  }

  @HasuraAction()
  public async me(@Req() request: Request) {
    const user = request.user;

    user.role = await this.cache.get(
      HasuraService.PLAYER_ROLE_CACHE_KEY(request.user.steam_id),
    );

    return user;
  }
}
