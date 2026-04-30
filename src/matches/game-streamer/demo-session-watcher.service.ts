import { Injectable, Logger } from "@nestjs/common";
import { GameStreamerService } from "./game-streamer.service";

type Watch = {
  matchMapId: string;
  userSteamId: string;
};

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
