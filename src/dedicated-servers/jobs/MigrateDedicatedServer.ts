import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
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
    await this.migrations.run(job.data.migrationId);
  }
}
