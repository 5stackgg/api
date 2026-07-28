declare module "globaloffensive" {
  import { EventEmitter } from "events";
  import SteamUser from "steam-user";

  class GlobalOffensive extends EventEmitter {
    constructor(steamUser: SteamUser);
    haveGCSession: boolean;
    requestGame(shareCode: string): void;
  }

  export = GlobalOffensive;
}
