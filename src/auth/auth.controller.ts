import { Controller, Get, UseGuards, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { SteamGuard } from "./strategies/SteamGuard";
import { HasuraAction } from "../hasura/hasura.controller";
import { DiscordGuard } from "./strategies/DiscordGuard";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { MeResponse } from "generated";

@Controller("auth")
export class AuthController {
  constructor(private readonly cache: CacheService) {}

  @UseGuards(SteamGuard)
  @Get("steam")
  public async steamLogin(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
  }

  @UseGuards(SteamGuard)
  @Get("steam/callback")
  public steamCallback(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
  }

  @UseGuards(DiscordGuard)
  @Get("discord")
  public async linkDiscord(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
  }

  @UseGuards(DiscordGuard)
  @Get("discord/callback")
  public linkDiscordCallback(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
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
