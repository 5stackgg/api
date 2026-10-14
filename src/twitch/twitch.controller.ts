import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { TwitchAccountsService } from "./twitch-accounts.service";

@Controller("twitch")
export class TwitchController {
  constructor(private readonly accounts: TwitchAccountsService) {}

  @Get("me")
  @UseGuards(SteamGuard)
  public async me(@Req() request: Request) {
    return await this.accounts.me(request.user.steam_id);
  }

  @Delete("me")
  @UseGuards(SteamGuard)
  public async unlink(@Req() request: Request) {
    await this.accounts.unlink(request.user.steam_id);

    return { success: true };
  }

  @Get("live")
  public async live(@Req() request: Request) {
    return {
      steam_ids: await this.accounts.liveSteamIds(request.user?.steam_id),
    };
  }

  @Get("players/:steamId")
  public async player(
    @Req() request: Request,
    @Param("steamId") steamId: string,
  ) {
    const player = await this.accounts.player(steamId, request.user?.steam_id);

    if (!player) {
      throw new NotFoundException();
    }

    return player;
  }

  @Get("matches/:matchId/streams")
  public async matchStreams(
    @Req() request: Request,
    @Param("matchId") matchId: string,
  ) {
    return {
      streams: await this.accounts.matchStreams(
        matchId,
        request.user?.steam_id,
      ),
    };
  }
}
