import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchmakingGateway } from "src/matchmaking/matchmaking.gateway";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelMatchMaking extends WorkerHost {
  constructor(private readonly matchmakingGateway: MatchmakingGateway) {
    super();
  }

  async process(
    job: Job<{
      confirmationId: string;
    }>,
  ): Promise<void> {
    const { confirmationId } = job.data;
    this.matchmakingGateway.cancelMatchMaking(confirmationId, true);
  }
}
