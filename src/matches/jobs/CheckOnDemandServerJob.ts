import { DelayedError, Job } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { DiscordBotOverviewService } from "../../discord-bot/discord-bot-overview/discord-bot-overview.service";
import {
  OnQueueEvent,
  QueueEventsHost,
  QueueEventsListener,
  WorkerHost,
} from "@nestjs/bullmq";

@UseQueue("Matches", MatchQueues.MatchServers)
export class CheckOnDemandServerJob extends WorkerHost {
  constructor(
    private readonly matchAssistant: MatchAssistantService,
    private readonly discordMatchOverview: DiscordBotOverviewService,
  ) {
    super();
  }
  async process(
    job: Job<{
      matchId: string;
    }>,
  ): Promise<void> {
    const { matchId } = job.data;

    const status = await this.matchAssistant.monitorOnDemandServerBoot(matchId);

    if (status === "pending") {
      await job.moveToDelayed(
        Date.now() + MatchAssistantService.ON_DEMAND_SERVER_BOOT_CHECK_DELAY_MS,
        job.token,
      );
      throw new DelayedError();
    }

    if (status !== "ready") {
      return;
    }

    await this.discordMatchOverview.updateMatchOverview(matchId);

    return;
  }
}

@QueueEventsListener(MatchQueues.MatchServers)
export class CheckOnDemandServerJobEvents extends QueueEventsHost {
  constructor(private readonly matchAssistant: MatchAssistantService) {
    super();
  }

  // QueueEvents carries only the job id, which names the match its check is for
  // (delayCheckOnDemandServer).
  @OnQueueEvent("failed")
  public async onFailed({ jobId }: { jobId: string; failedReason: string }) {
    const matchId = /^match\.(.+)\.server$/.exec(jobId)?.[1];

    if (matchId) {
      await this.matchAssistant.delayCheckOnDemandServer(matchId);
    }
  }
}
