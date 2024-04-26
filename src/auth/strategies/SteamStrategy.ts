import { Injectable } from "@nestjs/common";
import { Strategy } from "passport-steam";
import { PassportStrategy } from "@nestjs/passport";
import { HasuraService } from "../../hasura/hasura.service";
import {
  players_constraint,
  players_update_column,
} from "../../../generated/zeus";
import { Request } from "express";
import { DoneCallback } from "passport";

interface SteamProfile {
  provider: "steam";
  _json: {
    steamid: string;
    communityvisibilitystate: number;
    profilestate: number;
    personaname: string;
    commentpermission: number;
    profileurl: string;
    avatar: string;
    avatarmedium: string;
    avatarfull: string;
    avatarhash: string;
    lastlogoff: number;
    personastate: number;
    realname: string;
    primaryclanid: string;
    timecreated: number;
    personastateflags: number;
    loccountrycode: string;
    locstatecode: string;
  };
  id: string;
  displayName: string;
  photos: Array<{ value: string }>;
}

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

  async validate(
    request: Request,
    identifier: string,
    profile: SteamProfile,
    done: DoneCallback
  ): Promise<void> {
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
          name: true,
          steam_id: true,
          profile_url: true,
          avatar_url: true,
          discord_id: true,
        },
      ],
    });

    done(null, insert_players_one);
  }
}
