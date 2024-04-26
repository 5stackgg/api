import { PassportSerializer } from "@nestjs/passport";
import { Injectable } from "@nestjs/common";
import { User } from "../types/User";

@Injectable()
export class SteamSerializer extends PassportSerializer {
  serializeUser(user: User, done: CallableFunction) {
    console.info("SERIALSZE", user);
    done(null, user);
  }

  async deserializeUser(user: User, done: CallableFunction) {
    try {
      user.steam_id = BigInt(user.steam_id);
      return done(null, user);
    } catch (error) {
      console.warn("unable to get user", error);
    }
    return done(undefined, false);
  }
}
