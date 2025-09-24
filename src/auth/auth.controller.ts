import { Controller, Get, UseGuards, Req, Res, Logger } from "@nestjs/common";
import { request, Request, Response } from "express";
import { SteamGuard } from "./strategies/SteamGuard";
import { HasuraAction } from "../hasura/hasura.controller";
import { DiscordGuard } from "./strategies/DiscordGuard";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { SocketsGateway } from "src/sockets/sockets.gateway";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { ApiKeys } from "./ApiKeys";
import { BadRequestException } from "@nestjs/common";
import { User } from "./types/User";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly redis: RedisManagerService,
    private readonly apiKeys: ApiKeys,
    private readonly logger: Logger,
  ) {}

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

  @HasuraAction()
  public async unlinkDiscord(@Req() request: Request) {
    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: {
            steam_id: request.user.steam_id,
          },
          _set: {
            discord_id: null,
          },
        },
        __typename: true,
      },
    });

    request.user.discord_id = null;
    request.session.save();

    return { success: true };
  }

  @HasuraAction()
  public async logout(@Req() request: Request) {
    if (request.session) {
      await this.redis
        .getConnection()
        .del(SocketsGateway.GET_PLAYER_CLIENT_LATENCY_TEST(request.session.id));

      request.session.destroy((err) => {
        if (err) {
          this.logger.error("Error destroying session:", err);
        }
      });
    }
    return { success: true };
  }

  @HasuraAction()
  public async createApiKey(data: {
    user: User;
    label: string;
  }): Promise<{ key: string }> {
    const { label } = data;

    if (!label) {
      throw new BadRequestException("Label is required");
    }

    return {
      key: await this.apiKeys.createApiKey(label, data.user.steam_id),
    };
  }
}
