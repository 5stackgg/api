import { Processor, WorkerHost } from "@nestjs/bullmq";
import { CacheService } from "../../cache/cache.service";
import { GameServerQueues } from "../enums/GameServerQueues";

@Processor(GameServerQueues.GameUpdate)
export class CheckGameUpdate extends WorkerHost {
  constructor(private readonly cache: CacheService) {
    super();
  }

  async process(): Promise<void> {
    const response = await fetch("https://api.steamcmd.net/v1/info/730");
    const latestBuildTime = await this.cache.get("cs:updated-at");

    const { data } = await response.json();

    const { timeupdated } = data["730"].depots.branches.public;

    if (!latestBuildTime || latestBuildTime > parseInt(timeupdated)) {
      await this.cache.put("cs:updated-at", parseInt(timeupdated));
      // TODO - do update job on all nodes a daemonset!
    }
  }
}
