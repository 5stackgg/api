import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";
import jwt from "jsonwebtoken";
import { ConfigService } from "@nestjs/config";
import { User } from "./types/User";

@Injectable()
export class ApiKeys {
  private encSecret: string;
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
  ) {
    this.encSecret = this.config.get("app.encSecret");
  }

  public async createApiKey(label: string, steam_id: string) {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id,
        },
        role: true,
      },
    });

    if (!players_by_pk) {
      throw Error("Player not found");
    }

    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: "public.create_api_key_role",
        },
        value: true,
      },
    });

    const minRole = settings_by_pk?.value || "user";

    if (!isRoleAbove(players_by_pk?.role, minRole as e_player_roles_enum)) {
      throw Error("You are not authorized to create API keys");
    }

    const { insert_api_keys_one } = await this.hasura.mutation({
      insert_api_keys_one: {
        __args: {
          object: {
            label,
            steam_id,
          },
        },
        id: true,
      },
    });

    return this.generateJWT(insert_api_keys_one.id, steam_id);
  }

  private async generateJWT(id: string, steam_id: string) {
    return jwt.sign(
      {
        id,
        steam_id,
      },
      this.encSecret,
    );
  }

  public async verifyJWT(token: string): Promise<User | void> {
    try {
      const decoded = jwt.verify(token, this.encSecret) as {
        id: string;
        steam_id: string;
      };

      const { api_keys_by_pk } = await this.hasura.query({
        api_keys_by_pk: {
          __args: {
            id: decoded.id,
          },
          steam_id: true,
        },
      });

      if (!api_keys_by_pk) {
        return;
      }

      const { players_by_pk } = await this.hasura.query({
        players_by_pk: {
          __args: {
            steam_id: api_keys_by_pk.steam_id,
          },
          name: true,
          role: true,
          steam_id: true,
          profile_url: true,
          avatar_url: true,
          discord_id: true,
          language: true,
        },
      });

      if (!players_by_pk) {
        return;
      }

      return players_by_pk;
    } catch (error) {
      this.logger.error("unable to verify JWT", error);
    }
  }
}
