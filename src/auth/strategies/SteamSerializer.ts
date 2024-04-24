import { PassportSerializer } from "@nestjs/passport";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { User } from "../types/User";

@Injectable()
export class SteamSerializer extends PassportSerializer {
  @Inject()
  private readonly logger: Logger;

  serializeUser(user: User, done: CallableFunction) {
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
