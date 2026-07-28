declare module "globaloffensive" {
  import { EventEmitter } from "events";
  import SteamUser from "steam-user";

  class GlobalOffensive extends EventEmitter {
    constructor(steamUser: SteamUser);
    haveGCSession: boolean;
    requestGame(shareCode: string): void;
    // Returns false if the steam id is not a valid public individual id.
    requestRecentGames(steamId: string): boolean | void;
  }

  export = GlobalOffensive;
}
