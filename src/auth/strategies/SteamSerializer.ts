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

  async deserializeUser(user: User, done: CallableFunction) {
    try {
      return done(null, user);
    } catch (error) {
      this.logger.warn("unable to get user", error);
    }
    return done(undefined, false);
  }
}
