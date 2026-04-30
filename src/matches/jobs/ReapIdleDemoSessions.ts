import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameStreamerService } from "../game-streamer/game-streamer.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ReapIdleDemoSessions extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
  ) {
    super();
  }
  async process(): Promise<void> {
    try {
      await this.gameStreamer.reapIdleDemoSessions();
    } catch (error) {
      this.logger.error(
        `ReapIdleDemoSessions failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
