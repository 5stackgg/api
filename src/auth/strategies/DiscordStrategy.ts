import { Injectable } from "@nestjs/common";
import { Profile, Strategy } from "passport-discord";
import { PassportStrategy } from "@nestjs/passport";
import { HasuraService } from "../../hasura/hasura.service";
import { Request } from "express";
import { DoneCallback } from "passport";
import { ConfigService } from "@nestjs/config";
import { DiscordConfig } from "../../configs/types/DiscordConfig";
import { AppConfig } from "../../configs/types/AppConfig";

@Injectable()
export class DiscordStrategy extends PassportStrategy(Strategy) {
  constructor(
    private config: ConfigService,
    private readonly hasura: HasuraService,
  ) {
    const discordService = config.get<DiscordConfig>("discord");

    super({
      passReqToCallback: true,
      clientID: discordService.clientId,
      clientSecret: discordService.clientSecret,
      callbackURL: `${
        config.get<AppConfig>("app").webDomain
      }/auth/discord/callback`,
      scope: ["identify"],
    });
  }

  public async validate(
    request: Request,
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: DoneCallback,
  ) {
    await this.hasura.mutation({
      update_players_by_pk: [
        {
          pk_columns: {
            steam_id: request.user.steam_id,
          },
          _set: {
            discord_id: profile.id,
          },
        },
        {
          steam_id: true,
          name: true,
          profile_url: true,
          avatar_url: true,
          discord_id: true,
        },
      ],
    });

    request.user.discord_id = profile.id;

    done(null, request.user);
  }
}
