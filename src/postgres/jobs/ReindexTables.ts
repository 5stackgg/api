import { WorkerHost } from "@nestjs/bullmq";
import { PostgresService } from "../../postgres/postgres.service";
import { PostgresQueues } from "../enums/PostgresQueues";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { Job } from "bullmq";
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
      await this.postgres.query(`VACUUM (ANALYZE) ${job.data.table}`);

      this.logger.log(
        `Reindexed + vacuumed ${job.data.table}`,
        `${Date.now() - start}ms`,
      );
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
    // REINDEX CONCURRENTLY is not supported on TimescaleDB hypertables, so we
    // exclude them dynamically rather than maintaining a hardcoded list.
    const [{ exists: hasTimescale }] = await this.postgres.query<
      Array<{ exists: boolean }>
    >(`SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
      ) as exists`);

    const hypertableFilter = hasTimescale
      ? `AND NOT EXISTS (
          SELECT 1 FROM timescaledb_information.hypertables h
          WHERE h.hypertable_schema = t.schemaname
            AND h.hypertable_name = t.tablename
        )`
      : "";

    const tables = await this.postgres.query<
      Array<{
        tablename: string;
        schemaname: string;
      }>
    >(`SELECT t.tablename, t.schemaname FROM pg_tables t
        WHERE (t.schemaname = 'public')
        AND NOT t.tablename LIKE 'e_%'
        ${hypertableFilter}
      `);
    return tables.map((table) => `${table.schemaname}."${table.tablename}"`);
  }
}
