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

      const ts = backup.name.replace("backup-", "").replace(".zip", "");

      const year = parseInt(ts.slice(0, 4));
      const month = parseInt(ts.slice(4, 6)) - 1;
      const day = parseInt(ts.slice(6, 8));
      const hour = parseInt(ts.slice(8, 10));
      const minute = parseInt(ts.slice(10, 12));
      const second = parseInt(ts.slice(12, 14));

      await this.postgres.query(
        `insert into db_backups (name, size, created_at) values ($1, $2, $3)`,
        [
          backup.name,
          backup.size,
          new Date(Date.UTC(year, month, day, hour, minute, second)),
        ],
      );
    }

    await this.postgres.query(
      `delete from db_backups where not (name = any($1::text[]))`,
      [backups.map((backup) => backup.name)],
    );
  }
}
