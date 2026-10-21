import { WorkerHost } from "@nestjs/bullmq";
import { DelayedError, Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DedicatedServerQueues } from "../enums/DedicatedServerQueues";
import { DedicatedServerMigrationService } from "../dedicated-server-migration.service";

@UseQueue("DedicatedServers", DedicatedServerQueues.ServerMigrations, {
  concurrency: 3,
})
export class MigrateDedicatedServer extends WorkerHost {
  constructor(private readonly migrations: DedicatedServerMigrationService) {
    super();
  }

  async process(job: Job<{ migrationId: string }>): Promise<void> {
    const retryInMs = await this.migrations.run(job.data.migrationId);

    if (retryInMs) {
      await job.moveToDelayed(Date.now() + retryInMs, job.token);
      throw new DelayedError();
    }
  }
}
