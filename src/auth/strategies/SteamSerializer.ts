import { PassportSerializer } from "@nestjs/passport";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { User } from "../types/User";
import { CacheService } from "../../cache/cache.service";
import { HasuraService } from "../../hasura/hasura.service";

@Injectable()
export class SteamSerializer extends PassportSerializer {
  @Inject()
  private readonly logger: Logger;

  @Inject()
  private readonly cache: CacheService;

  @Inject()
  private readonly hasura: HasuraService;

  serializeUser(user: User, done: CallableFunction) {
    void this.cache
      .forget(HasuraService.PLAYER_NAME_CACHE_KEY(user.steam_id))
      .catch((error) => {
        this.logger.error("unable to forget player name cache", error);
      });

    void this.cache
      .forget(HasuraService.PLAYER_ROLE_CACHE_KEY(user.steam_id))
      .catch((error) => {
        this.logger.error("unable to forget player role cache", error);
      });

    done(null, user);
  }

  // `done(null, false)` drops the user from the session, so a failed lookup
  // fails the request instead of signing them out.
  async deserializeUser(user: User, done: CallableFunction) {
    let role: User["role"] | undefined;
    try {
      role = await this.hasura.getPlayerRole(user.steam_id);
    } catch (error) {
      this.logger.warn("unable to get player role", error);
      return done(error);
    }

    if (!role) {
      return done(null, false);
    }

    user.role = role;

    return done(null, user);
  }
}
