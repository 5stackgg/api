import { Controller, Get, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { DiscordConfig } from "src/configs/types/DiscordConfig";
import { HasuraService } from "src/hasura/hasura.service";

@Controller("/")
export class DiscordBotController {
  private discordConfig: DiscordConfig;

  constructor(
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
  ) {
    this.discordConfig = this.config.get<DiscordConfig>("discord");
  }

  @Get("/discord-bot")
  public async bot(@Req() request: Request, @Res() response: Response) {
    if (request.user.role !== "administrator") {
      throw Error("not authorized");
    }

    // https://discordapi.com/permissions.html
    // https://discordlookup.com/permissions-calculator/326434581584
    const permissions = `326434581584`;

    return response.redirect(
      302,
      `https://discord.com/oauth2/authorize?client_id=${this.discordConfig.clientId}&permissions=${permissions}&scope=bot%20applications.commands`,
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
