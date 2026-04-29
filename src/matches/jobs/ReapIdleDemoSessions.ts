import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameStreamerService } from "../game-streamer/game-streamer.service";

// Sweeps match_demo_sessions for rows whose last_activity_at is older
// than the idle threshold and tears down both the K8s job + the row.
//
// Activity is bumped on every demoControl call (api side, before the
// network hop to spec-server) so a working session keeps its row
// fresh — only abandoned tabs / dead pods fall behind.
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
      // Default threshold (60s): the popup pings every 10s, so 6
      // missed pings means the window is gone — closed, lost
      // network, or crashed.
      await this.gameStreamer.reapIdleDemoSessions();
    } catch (error) {
      this.logger.error(
        `ReapIdleDemoSessions failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
