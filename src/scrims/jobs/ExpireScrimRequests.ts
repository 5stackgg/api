import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ScrimQueues } from "../enums/ScrimQueues";
import { ScrimsService } from "../scrims.service";

@UseQueue("Scrims", ScrimQueues.ScrimMatcher)
export class ExpireScrimRequests extends WorkerHost {
  constructor(private readonly scrims: ScrimsService) {
    super();
  }

  async process(): Promise<void> {
    await this.scrims.expireStaleRequests();
  }
}
