import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchmakeService } from "src/matchmaking/matchmake.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelMatchMaking extends WorkerHost {
  constructor(private readonly matchmaking: MatchmakeService) {
    super();
  }

  async process(
    job: Job<{
      confirmationId: string;
    }>,
  ): Promise<void> {
    const { confirmationId } = job.data;
    this.matchmaking.cancelMatchMaking(confirmationId, true);
  }
}
