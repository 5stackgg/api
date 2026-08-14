import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { VoiceQueues } from "../enums/VoiceQueues";
import { VoiceService } from "../voice.service";

// A queued job rather than a timer in the service: a repeatable job is picked
// up by one worker, where a setInterval would run on every pod and have them
// race each other's snapshots.
@UseQueue("Voice", VoiceQueues.Monitor)
export class MonitorVoiceChannels extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly voice: VoiceService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.voice.monitorChannels();
    } catch (error) {
      this.logger.error(
        `MonitorVoiceChannels failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
