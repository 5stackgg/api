import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchQueues } from "../enums/MatchQueues";
import { WorkerHost } from "@nestjs/bullmq";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class RestartDedicatedServer extends WorkerHost {
  constructor(private readonly matchAssistant: MatchAssistantService) {
    super();
  }

  async process(
    job: Job<{
      serverId: string;
    }>,
  ): Promise<void> {
    const { serverId } = job.data;
    await this.matchAssistant.restartDedicatedServer(serverId);
  }
}
