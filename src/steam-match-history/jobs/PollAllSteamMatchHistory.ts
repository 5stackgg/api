import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamMatchHistoryService } from "../steam-match-history.service";
import { SteamBansService } from "../steam-bans.service";

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.PollAllSteamMatchHistory)
export class PollAllSteamMatchHistory extends WorkerHost {
  constructor(
    private readonly steamMatchHistory: SteamMatchHistoryService,
    private readonly steamBans: SteamBansService,
  ) {
    super();
  }

  async process(): Promise<void> {
    if (!this.steamMatchHistory.isEnabled()) {
      return;
    }
    await this.steamBans.checkAllActive();
    await this.steamMatchHistory.pollAllActive();
  }
}
