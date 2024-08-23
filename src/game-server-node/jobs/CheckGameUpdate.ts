import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { GameServeQueues } from "../enums/GameServeQueues";
import { HasuraService } from "../../hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { SteamConfig } from "../../configs/types/SteamConfig";
import { CacheService } from "../../cache/cache.service";

interface Build {
  buildid: number;
  timeupdated: number;
  timecreated: number;
}

interface SteamBuildsResponse {
  response: {
    builds: Build[];
  };
}

@Processor(GameServeQueues.GameUpdate)
export class CheckGameUpdate extends WorkerHost {
  private options: SteamConfig;

  constructor(
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {
    super();
    this.options = this.config.get("steam");
  }

  async process(): Promise<void> {
    try {
      const response = await fetch("https://api.steamcmd.net/v1/info/730");
      const latestBuildTime = await this.cache.get("cs:updated-at");

      const { data } = await response.json();

      const { timeupdated } = data["730"].depots.branches.public;

      if (!latestBuildTime || latestBuildTime > parseInt(timeupdated)) {
        await this.cache.put("cs:updated-at", parseInt(timeupdated));
        // TODO - do update job on all nodes a daemonset!
      }
    } catch (error) {
      console.error("Error checking for new build:", error);
    }
  }
}
