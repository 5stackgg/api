import { Injectable } from "@nestjs/common";
import { Strategy } from "passport-discord";
import { PassportStrategy } from "@nestjs/passport";
import { HasuraService } from "../../hasura/hasura.service";

@Injectable()
export class DiscordStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly hasura: HasuraService) {
    super({
      passReqToCallback: true,
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: `${process.env.WEB_DOMAIN}/auth/discord/callback`,
      scope: ["identify"],
    });
  }

  public async validate(request, accessToken, refreshToken, profile, done) {
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
