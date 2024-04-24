import { Controller, Get, UseGuards, Request, Response } from "@nestjs/common";
import { SteamGuard } from "./strategies/SteamGuard";
import { HasuraAction } from "../hasura/actions/actions.controller";

@Controller("auth")
export class AuthController {
  @UseGuards(SteamGuard)
  @Get("steam")
  public async login(@Request() request) {
    const { redirect } = request.query;

    request.session.redirect = process.env.WEB_DOMAIN;

    if (process.env.DEV && redirect) {
      request.session.redirect = redirect as string;
    }

    return;
  }

  @UseGuards(SteamGuard)
  @Get("steam/callback")
  public linkedinCallBack(@Request() request, @Response() response) {
    // TODO - handle dev redirect
    return response.redirect("/");
  }

  @HasuraAction()
  public async me(@Request() request) {
    return request.user;
  }
}
