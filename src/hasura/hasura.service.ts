import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createClient,
  FieldsSelection,
  type mutation_root,
  type mutation_rootGenqlSelection,
  type query_root,
  type query_rootGenqlSelection,
} from "../../generated";
import { HasuraConfig } from "../configs/types/HasuraConfig";
import { CacheService } from "../cache/cache.service";

@Injectable()
export class HasuraService {
  private config: HasuraConfig;

  constructor(
    protected readonly cache: CacheService,
    protected readonly configService: ConfigService,
  ) {
    this.config = configService.get<HasuraConfig>("hasura");
  }

  public static PLAYER_ROLE_CACHE_KEY(steamId: bigint | string) {
    return `user:${steamId.toString()}`;
  }

  public async query<R extends query_rootGenqlSelection>(
    request: R & { __name?: string },
    user?: User,
  ): Promise<FieldsSelection<query_root, R>> {
    try {
      return await (await this.getClient(user)).query(request);
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  public async mutation<R extends mutation_rootGenqlSelection>(
    request: R & { __name?: string },
  ): Promise<FieldsSelection<mutation_root, R>> {
    try {
      return await (await this.getClient()).mutation(request);
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  private async getClient(user?: User) {
    return createClient({
      url: `${this.config.endpoint}/v1/graphql`,
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": this.config.secret,
        ...(user ? await this.getHasuraHeaders(user) : {}),
      },
    });
  }

  public async getHasuraHeaders(user: User) {
    const playerRole = await this.cache.remember(
      HasuraService.PLAYER_ROLE_CACHE_KEY(user.steam_id),
      async () => {
        const { players_by_pk } = await this.query({
          players_by_pk: {
            __args: {
              steam_id: user.steam_id,
            },
            role: true,
          },
        });

        return players_by_pk?.role;
      },
      60 * 60 * 1000,
    );

    return {
      "x-hasura-role": playerRole,
      "x-hasura-user-id": user.steam_id.toString(),
    };
  }
}
