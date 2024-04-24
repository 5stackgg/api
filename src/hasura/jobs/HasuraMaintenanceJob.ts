import { Processor, WorkerHost } from "@nestjs/bullmq";
import { PostgresService } from "../../postgres/postgres.service";
import { HasuraQueues } from "../enums/HasuraQueues";

@Processor(HasuraQueues.Hasura)
export class HasuraMaintenanceJob extends WorkerHost {
  constructor(private readonly postgres: PostgresService) {
    super();
  }
  async process(): Promise<void> {
    await this.postgres.query(`truncate hdb_catalog.event_invocation_logs`);
    await this.postgres.query(
      `delete from hdb_catalog.hdb_action_log where created_at < now() - interval '1 days'`
    );
    await this.postgres.query(
      `delete from hdb_catalog.event_log where delivered = true or created_at < now() - interval '1 days'`
    );

    console.info("Hasura Maintenance Finished");

    return;
  }
}
