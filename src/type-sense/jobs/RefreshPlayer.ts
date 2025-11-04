import { WorkerHost } from "@nestjs/bullmq";
import { TypesenseQueues } from "../enums/TypesenseQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { Job } from "bullmq";
import { TypeSenseService } from "../type-sense.service";

@UseQueue("TypeSense", TypesenseQueues.TypeSense)
export class RefreshPlayerJob extends WorkerHost {
  constructor(private readonly typeSense: TypeSenseService) {
    super();
  }
  async process(
    job: Job<{
      steamId: string;
    }>,
  ): Promise<void> {
    await this.typeSense.updatePlayer(job.data.steamId);
  }
}
