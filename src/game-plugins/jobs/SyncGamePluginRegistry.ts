import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GamePluginQueues } from "../enums/GamePluginQueues";
import { GamePluginsService } from "../game-plugins.service";

@UseQueue("GamePlugins", GamePluginQueues.Registry)
export class SyncGamePluginRegistry extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly gamePlugins: GamePluginsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.gamePlugins.syncRegistry();
    } catch (error) {
      // The catalog is a cache of somebody else's uptime. A failed poll leaves
      // the last good copy in place rather than emptying the directory.
      this.logger.warn(`unable to sync the plugin registry`, error.message);
    }
  }
}
