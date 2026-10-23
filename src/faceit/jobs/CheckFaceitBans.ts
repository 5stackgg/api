import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { FaceitQueues } from "../enums/FaceitQueues";
import { FaceitBansService } from "../faceit-bans.service";

@UseQueue("Faceit", FaceitQueues.CheckFaceitBans, {
  concurrency: 2,
  limiter: { max: 30, duration: 60_000 },
})
export class CheckFaceitBans extends WorkerHost {
  constructor(private readonly faceitBans: FaceitBansService) {
    super();
  }

  async process(job: Job<{ steamId: string }>): Promise<void> {
    await this.faceitBans.checkPlayer(job.data.steamId);
  }
}
