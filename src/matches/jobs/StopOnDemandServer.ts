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
      jobName?: string;
      jobUid?: string;
    }>,
  ): Promise<void> {
    const { matchId, jobName, jobUid } = job.data;

    if (jobUid) {
      await this.matchAssistant.removeUnstoppedOnDemandServer(
        matchId,
        jobUid,
        jobName,
      );
      return;
    }

    await this.matchAssistant.stopEndedMatchServer(matchId);
  }
}
