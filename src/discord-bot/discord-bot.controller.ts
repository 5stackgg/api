import { Controller, Get, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";

@Controller("discord-bot")
export class DiscordBotController {
  @Get("/discord-bot")
  public async bot(@Req() request: Request, @Res() response: Response) {
    // https://discordapi.com/permissions.html
    const permissions = `326434581584`;

    return response.redirect(
      302,
      `https://discord.com/oauth2/authorize?client_id=1168695390502141982&permissions=${permissions}&scope=bot%20applications.commands`,
    );
  }
}
