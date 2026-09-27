import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { MatchRelayService } from "../match-relay/match-relay.service";
import { ClipsService } from "../clips/clips.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class StopMatchBroadcast extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly matchAssistant: MatchAssistantService,
    private readonly gameStreamer: GameStreamerService,
    private readonly matchRelay: MatchRelayService,
    private readonly clips: ClipsService,
  ) {
    super();
  }

  async process(job: Job<{ matchId: string }>): Promise<void> {
    const { matchId } = job.data;

    if (!(await this.matchAssistant.hasMatchEnded(matchId))) {
      this.logger.log(
        `[${matchId}] match was started again, leaving its broadcast running`,
      );
      return;
    }

    await this.matchRelay.removeBroadcast(matchId);

    if (!(await this.gameStreamer.stopLiveIfRunning(matchId))) {
      return;
    }

    const { promoted } = await this.gameStreamer.promotePendingLiveStreams();
    if (promoted.length === 0) {
      await this.clips.resumeAllPausedBatches();
    }
  }
}
