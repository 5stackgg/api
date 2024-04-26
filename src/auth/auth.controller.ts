import { Controller, Get, UseGuards, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { SteamGuard } from "./strategies/SteamGuard";
import { HasuraAction } from "../hasura/hasura.controller";
import { DiscordGuard } from "./strategies/DiscordGuard";

@Controller("auth")
export class AuthController {
  @UseGuards(SteamGuard)
  @Get("steam")
  public async steamLogin(@Req() request: Request) {
    const { redirect } = request.query;

    request.session.redirect = process.env.WEB_DOMAIN;

    if (process.env.DEV && redirect) {
      request.session.redirect = redirect as string;
    }

    return;
  }

  @UseGuards(SteamGuard)
  @Get("steam/callback")
  public steamCallback(@Req() request: Request, @Res() res: Response) {
    // TODO - handle dev redirect
    return res.redirect("/");
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
    return request.user;
  }
}
