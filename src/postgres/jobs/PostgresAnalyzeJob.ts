import { WorkerHost } from "@nestjs/bullmq";
import { PostgresService } from "../../postgres/postgres.service";
import { PostgresQueues } from "../enums/PostgresQueues";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";

@UseQueue("Postgres", PostgresQueues.Postgres)
export class PostgresAnalyzeJob extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }
  async process(): Promise<void> {
    this.logger.debug("Running Analyze");

    await this.postgres.query(`Analyze`);

    this.logger.debug("Analyze Finished");
    return;
  }
}
