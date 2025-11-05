import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { SystemQueues } from "../enums/SystemQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { SystemService } from "../system.service";

@UseQueue("System", SystemQueues.Version)
export class CheckSystemUpdateJob extends WorkerHost {
  constructor(private readonly system: SystemService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.system.setVersions();
  }
}
