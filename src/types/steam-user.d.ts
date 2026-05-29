declare module "steam-user" {
  import { EventEmitter } from "events";

  interface SteamID {
    getSteamID64(): string;
  }

  interface LogOnDetails {
    accountName?: string;
    password?: string;
    refreshToken?: string;
    twoFactorCode?: string;
  }

  class SteamUser extends EventEmitter {
    constructor(options?: { enablePicsCache?: boolean; autoRelogin?: boolean });
    steamID?: SteamID | null;
    logOn(details: LogOnDetails): void;
    logOff(): void;
    setPersona(state: number): void;
    gamesPlayed(apps: number[] | number): void;
    sendToGC(
      appId: number,
      msgType: number,
      protoBufHeader: Record<string, unknown> | null,
      body: Buffer | Record<string, unknown>,
    ): void;
  }

  namespace SteamUser {
    const EPersonaState: {
      Offline: 0;
      Online: 1;
      Busy: 2;
      Away: 3;
      Snooze: 4;
      LookingToTrade: 5;
      LookingToPlay: 6;
      Invisible: 7;
    };
    function generateAuthCode(sharedSecret: string): string;
  }

  export = SteamUser;
}
