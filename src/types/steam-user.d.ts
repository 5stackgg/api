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
    // Map of friend steamid64 -> EFriendRelationship.
    myFriends: Record<string, number>;
    logOn(details: LogOnDetails): void;
    logOff(): void;
    setPersona(state: number): void;
    gamesPlayed(apps: number[] | number): void;
    addFriend(
      steamId: string,
      callback?: (err: Error | null, personaName?: string) => void,
    ): void;
    chat: {
      sendFriendMessage(
        steamId: string,
        message: string,
        callback?: (err: Error | null) => void,
      ): void;
    };
    getSteamLevels(
      steamIds: string[],
      callback: (err: Error | null, levels: Record<string, number>) => void,
    ): void;
    requestRichPresence(
      appId: number,
      steamIds: string[],
      callback: (
        err: Error | null,
        response: {
          users: Record<
            string,
            {
              rich_presence?:
                | Record<string, string>
                | Array<{ key?: string; value?: string }>;
              localized_string?: string;
              rich_presence_string?: string;
            }
          >;
        },
      ) => void,
    ): void;
    getPersonas(
      steamIds: string[],
      callback: (
        err: Error | null,
        personas: Record<
          string,
          {
            gameid?: string | number | null;
            rich_presence?:
              | Record<string, string>
              | Array<{ key?: string; value?: string }>;
          }
        >,
      ) => void,
    ): void;
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
    const EFriendRelationship: {
      None: 0;
      Blocked: 1;
      RequestRecipient: 2;
      Friend: 3;
      RequestInitiator: 4;
      Ignored: 5;
      IgnoredFriend: 6;
      SuggestedFriend: 7;
    };
    function generateAuthCode(sharedSecret: string): string;
  }

  export = SteamUser;
}
