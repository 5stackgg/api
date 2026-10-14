import { PostgresService } from "../postgres/postgres.service";

// What a server says about Steam's relay network. A plugin from before it said
// either way leaves onRelay null.
export type SteamRelayWord = {
  onRelay: boolean | null;
  address: string | null;
};

/**
 * The one place a server's relay address is written, whichever plugin reports
 * it: the match plugin on its ping, the practice plugin on its session and
 * occupancy, player management on its sync.
 *
 * The server is the only one that knows whether it listens on the relay, so
 * its word is the whole answer. The region's setting decides how a pod is
 * booted and nothing after that, and nothing the panel works out for itself
 * ever lands here.
 */
export class SteamRelay {
  // A Steam ID as the plugins render it, e.g. [A:1:3653557264:51859]. The
  // address ends up inside the connect command players run, so anything else a
  // server sends is no address at all.
  private static readonly ADDRESS = /^\[[A-Za-z]:\d{1,3}:\d{1,10}:\d{1,10}\]$/;

  // Request fields are whatever the plugin sent, as a body value or a query
  // string.
  public static word(onRelay: unknown, address: unknown): SteamRelayWord {
    return {
      onRelay:
        onRelay === true || onRelay === "true"
          ? true
          : onRelay === false || onRelay === "false"
            ? false
            : null,
      address:
        typeof address === "string" && SteamRelay.ADDRESS.test(address.trim())
          ? address.trim()
          : null,
    };
  }

  // A server on the relay that cannot yet say where is not up: the only
  // address left to hand out for it is a host and port that reaches nobody.
  public static isUp(word: SteamRelayWord): boolean {
    return !(word.onRelay === true && !word.address);
  }

  /**
   * Off the relay clears the address and an address sets it. No address on its
   * own changes nothing: a server still registering with the relay has none
   * yet, and a plugin that never said which has none to give off it.
   *
   * Answers whether the server can be called up.
   */
  public static async report(
    postgres: PostgresService,
    serverId: string,
    word: SteamRelayWord,
  ): Promise<boolean> {
    if (word.onRelay === false) {
      await postgres.query(
        `UPDATE public.servers
            SET steam_relay = NULL
          WHERE id = $1::uuid
            AND steam_relay IS NOT NULL`,
        [serverId],
      );
      return true;
    }

    if (!word.address) {
      return SteamRelay.isUp(word);
    }

    await postgres.query(
      `UPDATE public.servers
          SET steam_relay = $2
        WHERE id = $1::uuid
          AND steam_relay IS DISTINCT FROM $2`,
      [serverId, word.address],
    );

    return true;
  }
}
