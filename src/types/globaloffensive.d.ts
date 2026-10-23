declare module "globaloffensive" {
  import { EventEmitter } from "events";
  import SteamUser from "steam-user";

  class GlobalOffensive extends EventEmitter {
    constructor(steamUser: SteamUser);
    haveGCSession: boolean;
    requestGame(
      shareCodeOrDetails:
        | string
        | { matchId: string; outcomeId: string; token: string },
    ): void;
  }

  export = GlobalOffensive;
}
