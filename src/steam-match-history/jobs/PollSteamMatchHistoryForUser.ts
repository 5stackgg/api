import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamMatchHistoryService } from "../steam-match-history.service";

@UseQueue(
  "SteamMatchHistory",
  SteamMatchHistoryQueues.PollSteamMatchHistoryForUser,
)
export class PollSteamMatchHistoryForUser extends WorkerHost {
  constructor(private readonly steamMatchHistory: SteamMatchHistoryService) {
    super();
  }

  async process(job: Job<{ steamId: string }>): Promise<void> {
    if (!job.data.steamId) {
      return;
    }
    await this.steamMatchHistory.pollForUser(job.data.steamId);
  }
}
