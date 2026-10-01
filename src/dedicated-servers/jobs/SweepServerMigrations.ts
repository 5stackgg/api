import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DedicatedServerQueues } from "../enums/DedicatedServerQueues";
import { DedicatedServerMigrationService } from "../dedicated-server-migration.service";

@UseQueue("DedicatedServers", DedicatedServerQueues.ServerMaintenance, {
  concurrency: 3,
})
export class SweepServerMigrations extends WorkerHost {
  constructor(private readonly migrations: DedicatedServerMigrationService) {
    super();
  }

  async process(): Promise<void> {
    await this.migrations.sweep();
  }
}
