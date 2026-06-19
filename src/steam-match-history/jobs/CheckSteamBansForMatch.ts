import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamBansService } from "../steam-bans.service";

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.CheckSteamBansForMatch)
export class CheckSteamBansForMatch extends WorkerHost {
  constructor(private readonly steamBans: SteamBansService) {
    super();
  }

  async process(job: Job<{ matchId: string }>): Promise<void> {
    if (!job.data.matchId) {
      return;
    }
    await this.steamBans.checkMatchPlayers(job.data.matchId);
  }
}
