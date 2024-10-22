import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchMakingGateway } from "src/match-making/match-making.gateway";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelMatchMaking extends WorkerHost {
  constructor(private readonly matchMakingGateway: MatchMakingGateway) {
    super();
  }

  async process(
    job: Job<{
      confirmationId: string;
    }>,
  ): Promise<void> {
    const { confirmationId } = job.data;
    this.matchMakingGateway.cancelMatchMaking(confirmationId, true);
  }
}
