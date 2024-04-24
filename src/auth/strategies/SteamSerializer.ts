import { PassportSerializer } from "@nestjs/passport";
import { Injectable } from "@nestjs/common";

@Injectable()
export class SteamSerializer extends PassportSerializer {
  serializeUser(user, done: CallableFunction) {
    done(null, user);
  }

  async deserializeUser(user: string, done: CallableFunction) {
    try {
      return done(null, user);
    } catch (error) {
      console.warn("unable to get user", error);
    }
    return done(undefined, false);
  }
}
