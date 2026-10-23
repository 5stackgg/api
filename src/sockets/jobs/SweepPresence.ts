import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { SocketQueues } from "../enums/SocketQueues";
import { PresenceService } from "../presence.service";

// A queued job so one pod sweeps, not every pod at once.
@UseQueue("Sockets", SocketQueues.Presence)
export class SweepPresence extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly presence: PresenceService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.presence.sweep();
    } catch (error) {
      this.logger.error(
        `SweepPresence failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
