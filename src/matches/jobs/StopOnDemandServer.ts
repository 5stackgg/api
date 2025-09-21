import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchQueues } from "../enums/MatchQueues";
import { WorkerHost } from "@nestjs/bullmq";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class StopOnDemandServer extends WorkerHost {
  constructor(private readonly matchAssistant: MatchAssistantService) {
    super();
  }

  async process(
    job: Job<{
      matchId: string;
    }>,
  ): Promise<void> {
    const { matchId } = job.data;
    await this.matchAssistant.stopOnDemandServer(matchId);
  }
}
