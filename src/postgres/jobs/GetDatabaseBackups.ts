import { WorkerHost } from "@nestjs/bullmq";
import { PostgresService } from "../postgres.service";
import { PostgresQueues } from "../enums/PostgresQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { S3Service } from "src/s3/s3.service";
import { ConfigService } from "@nestjs/config";

@UseQueue("Postgres", PostgresQueues.Postgres)
export class GetDatabaseBackups extends WorkerHost {
  constructor(
    private readonly s3: S3Service,
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
  ) {
    super();
  }
  async process(): Promise<void> {
    const backups = await this.s3.list(
      this.configService.get("s3.db_backup_bucket"),
    );

    for (const backup of backups) {
      const existingBackup = await this.postgres.query<any[]>(
        `select * from db_backups where name = $1`,
        [backup.name],
      );
      if (existingBackup.length > 0) {
        continue;
      }

      await this.postgres.query(
        `insert into db_backups (name, size, created_at) values ($1, $2, $3)`,
        [
          backup.name,
          backup.size,
          new Date(
            parseInt(backup.name.replace("backup-", "").replace(".zip", "")),
          ),
        ],
      );
    }

    await this.postgres.query(
      `delete from db_backups where not (name = any($1::text[]))`,
      [backups.map((backup) => backup.name)],
    );
  }
}
