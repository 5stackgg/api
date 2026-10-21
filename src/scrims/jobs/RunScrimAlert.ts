import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ScrimQueues } from "../enums/ScrimQueues";
import { ScrimsService } from "../scrims.service";

@UseQueue("Scrims", ScrimQueues.ScrimMatcher)
export class RunScrimAlert extends WorkerHost {
  constructor(private readonly scrims: ScrimsService) {
    super();
  }

  async process(job: Job<{ alertId: string }>): Promise<void> {
    if (!(await this.scrims.isFinderEnabled())) {
      return;
    }

    await this.scrims.runScrimAlerts({ alertId: job.data.alertId });
  }
}
