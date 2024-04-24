import { Injectable } from "@nestjs/common";
import { Strategy } from "passport-steam";
import { PassportStrategy } from "@nestjs/passport";
import { HasuraService } from "../../hasura/hasura.service";
import {
  players_constraint,
  players_update_column,
} from "../../../generated/zeus";

@Injectable()
export class SteamStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly hasura: HasuraService) {
    super({
      passReqToCallback: true,
      realm: process.env.WEB_DOMAIN,
      apiKey: process.env.CS_AUTH_KEY,
      returnURL: `${process.env.WEB_DOMAIN}/auth/steam/callback`,
    });
  }

  async validate(req, identifier, profile, done): Promise<any> {
    const { steamid, personaname, profileurl, avatarfull } = profile._json;

    const { insert_players_one } = await this.hasura.mutation({
      insert_players_one: [
        {
          object: {
            steam_id: steamid,
            name: personaname,
            profile_url: profileurl,
            avatar_url: avatarfull,
          },
          on_conflict: {
            constraint: players_constraint.players_steam_id_key,
            update_columns: [
              players_update_column.name,
              players_update_column.avatar_url,
              players_update_column.profile_url,
            ],
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

    done(null, insert_players_one);
  }
}
