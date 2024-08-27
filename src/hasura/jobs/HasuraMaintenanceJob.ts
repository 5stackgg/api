import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { HasuraQueues } from "../enums/HasuraQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

@UseQueue("Hasura", HasuraQueues.Hasura)
export class HasuraMaintenanceJob extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }
  async process(): Promise<void> {
    await this.postgres.query(`truncate hdb_catalog.event_invocation_logs`);
    await this.postgres.query(
      `delete from hdb_catalog.hdb_action_log where created_at < now() - interval '1 days'`,
    );
    await this.postgres.query(
      `delete from hdb_catalog.event_log where delivered = true or created_at < now() - interval '1 days'`,
    );

    this.logger.debug("Hasura Maintenance Finished");

    return;
  }
}
