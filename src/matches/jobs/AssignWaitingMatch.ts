import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";

@UseQueue("Matches", MatchQueues.MatchServers)
export class AssignWaitingMatch extends WorkerHost {
  constructor(private readonly matchAssistant: MatchAssistantService) {
    super();
  }

  async process(job: Job<{ region: string }>): Promise<void> {
    await this.matchAssistant.assignWaitingMatch(job.data.region);
  }
}
