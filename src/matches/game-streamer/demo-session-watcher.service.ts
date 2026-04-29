import { Injectable, Logger } from "@nestjs/common";
import { GameStreamerService } from "./game-streamer.service";

type Watch = {
  matchMapId: string;
  userSteamId: string;
};

/**
 * In-memory map of websocket clientId → demo session watches. The web
 * popup window has its own WS connection (separate window = separate
 * JS context = separate WS); when the popup closes, that connection's
 * `close` handler fires and we tear down any demo sessions registered
 * to it.
 *
 * No Redis-backed state on purpose: the watch only matters for the
 * lifetime of the connection, and a process restart drops both the
 * connections and their sessions together. The reaper (DB-driven, by
 * `last_activity_at`) is the cross-process backstop.
 */
@Injectable()
export class DemoSessionWatcherService {
  private readonly watches = new Map<string, Set<Watch>>();

  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  public register(clientId: string, watch: Watch) {
    let set = this.watches.get(clientId);
    if (!set) {
      set = new Set();
      this.watches.set(clientId, set);
    }
    // Dedup by (matchMapId, userSteamId) so repeat "watch" events from
    // the same client just refresh the in-memory record.
    for (const existing of set) {
      if (
        existing.matchMapId === watch.matchMapId &&
        existing.userSteamId === watch.userSteamId
      ) {
        return;
      }
    }
    set.add(watch);
    this.logger.log(
      `[demo-watcher] client=${clientId} now watching ${watch.matchMapId} (${set.size} total)`,
    );
  }

  public unregister(clientId: string, matchMapId: string, userSteamId: string) {
    const set = this.watches.get(clientId);
    if (!set) return;
    for (const w of set) {
      if (w.matchMapId === matchMapId && w.userSteamId === userSteamId) {
        set.delete(w);
        break;
      }
    }
    if (set.size === 0) this.watches.delete(clientId);
  }

  /**
   * Fired by SocketsService when a websocket client disconnects.
   * Tears down every demo session this client was watching — the user
   * closed the popup window. Reaper picks up anything we miss.
   */
  public async clientClosed(clientId: string): Promise<void> {
    const set = this.watches.get(clientId);
    if (!set || set.size === 0) return;
    this.watches.delete(clientId);

    for (const watch of set) {
      this.logger.log(
        `[demo-watcher] client=${clientId} closed — stopping session for ${watch.matchMapId}/${watch.userSteamId}`,
      );
      try {
        await this.gameStreamer.stopDemoPlayback(
          watch.matchMapId,
          watch.userSteamId,
        );
      } catch (error) {
        this.logger.error(
          `[demo-watcher] stopDemoPlayback failed for ${watch.matchMapId}/${watch.userSteamId}: ${(error as Error)?.message}`,
        );
      }
    }
  }
}
