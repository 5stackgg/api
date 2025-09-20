import { WorkerHost } from "@nestjs/bullmq";
import { PostgresService } from "../../postgres/postgres.service";
import { PostgresQueues } from "../enums/PostgresQueues";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { Job, Queue } from "bullmq";
import { InjectFlowProducer } from "@nestjs/bullmq";
import { FlowProducer } from "bullmq";

@UseQueue("Postgres", PostgresQueues.Postgres)
export class ReindexTables extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    @InjectFlowProducer("reindex") private flowProducer: FlowProducer,
  ) {
    super();
  }
  async process(
    job: Job<{
      table?: string;
      final?: boolean;
    }>,
  ): Promise<void> {
    if (job.data && job.data.table) {
      const start = Date.now();

      await this.postgres.query(`REINDEX TABLE CONCURRENTLY ${job.data.table}`);

      this.logger.log(`Reindexed ${job.data.table}`, `${Date.now() - start}ms`);
      return;
    }

    if (job.data.final) {
      return;
    }

    this.logger.log("Reindexing tables");
    const tables = await this.getTablesToReindex();

    await this.flowProducer.add({
      name: ReindexTables.name,
      queueName: PostgresQueues.Postgres,
      data: {
        final: true,
      },
      children: tables.map((table) => ({
        name: ReindexTables.name,
        data: { table },
        queueName: PostgresQueues.Postgres,
      })),
    });
    return;
  }

  private async getTablesToReindex() {
    // TODO - im not sure what todo about hypertables
    const tables = await this.postgres.query<
      Array<{
        tablename: string;
        schemaname: string;
      }>
    >(`SELECT tablename, schemaname FROM pg_tables 
        WHERE (schemaname = 'public') 
        AND NOT tablename LIKE 'e_%'
        AND tablename NOT IN (
          'player_utility',
          'player_flashes',
          'player_assists',
          'player_damages',
          'player_objectives',
          'player_kills',
          'player_sanctions'
        )
      `);
    return tables.map((table) => `${table.schemaname}."${table.tablename}"`);
  }
}
