import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { SystemQueues } from "../enums/SystemQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { SystemService } from "../system.service";

@UseQueue("System", SystemQueues.Version)
export class CheckSystemUpdateJob extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly system: SystemService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const versions = await this.system.getVersions();
    this.logger.warn("VERSION", versions);
  }
}
