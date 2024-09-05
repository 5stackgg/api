import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchMakingService } from "src/sockets/match-making.servcie";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelMatchMaking extends WorkerHost {
  constructor(private readonly matchMakingService: MatchMakingService) {
    super();
  }

  async process(
    job: Job<{
      confirmationId: string;
    }>,
  ): Promise<void> {
    const { confirmationId } = job.data;
    this.matchMakingService.cancelMatchMaking(confirmationId, true);
  }
}
