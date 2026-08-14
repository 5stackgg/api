import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { CameraMonitorService } from "../camera/camera-monitor.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class MonitorMatchCameras extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly cameraMonitor: CameraMonitorService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.cameraMonitor.monitorLiveMatches();
    } catch (error) {
      this.logger.error(
        `MonitorMatchCameras failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
