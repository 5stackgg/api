import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { TelemetryQueues } from "../enums/TelemetryQueues";
import { TelemetryService } from "../telemetry.service";

@UseQueue("Telemetry", TelemetryQueues.Telemetry)
export class SendBasicTelemetry extends WorkerHost {
  constructor(private readonly telemetryService: TelemetryService) {
    super();
  }

  async process(_job: Job<void>): Promise<void> {
    await this.telemetryService.send();
  }
}
