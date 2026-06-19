import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamBansService } from "../steam-bans.service";

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.CheckSteamBans, {
  concurrency: 1,
})
export class DrainSteamBans extends WorkerHost {
  constructor(private readonly steamBans: SteamBansService) {
    super();
  }

  async process(): Promise<void> {
    await this.steamBans.drainPending();
  }
}
