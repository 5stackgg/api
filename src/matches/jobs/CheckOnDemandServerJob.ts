import { Job } from "bullmq";
import {
  Processor,
  WorkerHost,
  OnQueueEvent,
  QueueEventsListener,
  QueueEventsHost,
} from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { DiscordBotOverviewService } from "../../discord-bot/discord-bot-overview/discord-bot-overview.service";

@Processor(MatchQueues.MatchServers)
export class CheckOnDemandServerJob extends WorkerHost {
  constructor(
    private readonly matchAssistant: MatchAssistantService,
    private readonly discordMatchOverview: DiscordBotOverviewService
  ) {
    super();
  }
  async process(
    job: Job<{
      matchId: string;
    }>
  ): Promise<void> {
    const { matchId } = job.data;

    const server = await this.matchAssistant.getMatchServer(matchId);

    if (!server) {
      return;
    }

    if (!(await this.matchAssistant.isOnDemandServerRunning(matchId))) {
      throw Error("on demand server is not running");
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

  @OnQueueEvent("failed")
  public async onCompleted(job: Job) {
    await this.matchAssistant.delayCheckOnDemandServer(job.data.matchId);
  }
}
