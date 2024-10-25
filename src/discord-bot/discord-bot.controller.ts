import { Controller, Get, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { HasuraService } from "src/hasura/hasura.service";

@Controller("/")
export class DiscordBotController {
  constructor(private readonly hasura: HasuraService) {}

  @Get("/discord-bot")
  public async bot(@Req() request: Request, @Res() response: Response) {
    // https://discordapi.com/permissions.html
    // https://discordlookup.com/permissions-calculator/326434581584
    const permissions = `326434581584`;

    return response.redirect(
      302,
      `https://discord.com/oauth2/authorize?client_id=1168695390502141982&permissions=${permissions}&scope=bot%20applications.commands`,
    );
  }

  @Get("/discord-invite")
  public async invite(@Req() request: Request, @Res() response: Response) {
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: "discord_invite_link",
        },
        value: true,
      },
    });

    return response.redirect(
      302,
      settings_by_pk?.value
        ? settings_by_pk.value
        : `https://discord.gg/6xUDQRAaYY`,
    );
  }
}
