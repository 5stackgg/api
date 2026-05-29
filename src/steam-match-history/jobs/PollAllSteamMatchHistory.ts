import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamMatchHistoryService } from "../steam-match-history.service";

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.PollAllSteamMatchHistory)
export class PollAllSteamMatchHistory extends WorkerHost {
  constructor(private readonly service: SteamMatchHistoryService) {
    super();
  }

  async process(): Promise<void> {
    if (!this.service.isEnabled()) {
      return;
    }
    await this.service.pollAllActive();
  }
}
