import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { DelayedError, Job } from "bullmq";
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
      signalledAt?: number;
    }>,
  ): Promise<void> {
    const { matchId, jobName, jobUid, signalledAt } = job.data;

    if (jobUid) {
      if (
        !(await this.matchAssistant.removeUnstoppedOnDemandServer(
          matchId,
          jobUid,
          jobName,
          signalledAt,
        ))
      ) {
        await job.moveToDelayed(
          Date.now() +
            MatchAssistantService.ON_DEMAND_SERVER_STOP_CHECK_DELAY_MS,
          job.token,
        );
        throw new DelayedError();
      }
      return;
    }

    await this.matchAssistant.stopEndedMatchServer(matchId);
  }
}
