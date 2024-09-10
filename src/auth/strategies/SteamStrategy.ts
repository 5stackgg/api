import { Injectable } from "@nestjs/common";
import { Strategy } from "passport-steam";
import { PassportStrategy } from "@nestjs/passport";
import { HasuraService } from "../../hasura/hasura.service";
import { Request } from "express";
import { DoneCallback } from "passport";
import { AppConfig } from "../../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";
import { SteamConfig } from "../../configs/types/SteamConfig";

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
  constructor(
    readonly config: ConfigService,
    private readonly hasura: HasuraService,
  ) {
    const webDomain = config.get<AppConfig>("app").webDomain;

    super({
      passReqToCallback: true,
      realm: webDomain,
      apiKey: config.get<SteamConfig>("steam").steamApiKey,
      returnURL: `https://${webDomain}/auth/steam/callback`,
    });
  }

  async validate(
    request: Request,
    identifier: string,
    profile: SteamProfile,
    done: DoneCallback,
  ): Promise<void> {
    const { steamid, personaname, profileurl, avatarfull } = profile._json;

    const { insert_players_one } = await this.hasura.mutation({
      insert_players_one: {
        __args: {
          object: {
            steam_id: steamid,
            name: personaname,
            profile_url: profileurl,
            avatar_url: avatarfull,
            role: "user",
          },
          on_conflict: {
            constraint: "players_steam_id_key",
            update_columns: ["name", "avatar_url", "profile_url"],
          },
        },
        name: true,
        role: true,
        steam_id: true,
        profile_url: true,
        avatar_url: true,
        discord_id: true,
      },
    });

    done(null, insert_players_one);
  }
}
