import { Processor, WorkerHost } from "@nestjs/bullmq";
import { PostgresService } from "../../postgres/postgres.service";
import { PostgresQueues } from "../enums/PostgresQueues";

@Processor(PostgresQueues.Postgres)
export class PostgresAnalyzeJob extends WorkerHost {
  constructor(private readonly postgres: PostgresService) {
    super();
  }
  async process(): Promise<void> {
    console.info("Running Analyze");

    await this.postgres.query(`Analyze`);

    console.info("Analyze Finished");
    return;
  }
}
