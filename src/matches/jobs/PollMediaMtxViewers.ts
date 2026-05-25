import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameStreamerService } from "../game-streamer/game-streamer.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class PollMediaMtxViewers extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
  ) {
    super();
  }
  async process(): Promise<void> {
    try {
      await this.gameStreamer.pollMediaMtxViewers();
    } catch (error) {
      this.logger.error(
        `PollMediaMtxViewers failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
