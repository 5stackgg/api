import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatQueues } from "../enums/ChatQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { SystemSettingName } from "../../system/enums/SystemSettingName";

const DEFAULT_RETENTION_DAYS = 365;

// DM retention, which is a sweep rather than a TTL because the messages live in
// postgres. 0 days means keep them forever, which is a real answer an operator
// might want and the reason this is a setting at all.
//
// Reads the setting straight out of postgres rather than through SystemService:
// SystemModule imports ChatModule, so depending on it from here closes a module
// cycle that Nest cannot resolve, for the sake of one scalar.
@UseQueue("Chat", ChatQueues.ChatMaintenance)
export class PruneDirectMessages extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const days = await this.retentionDays();

    if (!days || days <= 0) {
      return;
    }

    const deleted = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM public.direct_messages
             WHERE created_at < now() - make_interval(days => $1::int)
         RETURNING id::text AS id`,
      [days],
    );

    // A conversation whose every message has aged out is no longer a
    // conversation, and leaving the row behind would keep an empty thread at
    // the top of somebody's inbox forever.
    await this.postgres.query(
      `DELETE FROM public.direct_conversations dc
             WHERE NOT EXISTS (
               SELECT 1 FROM public.direct_messages dm
                WHERE dm.room_id = dc.room_id
             )`,
    );

    if (deleted.length > 0) {
      this.logger.log(
        `pruned ${deleted.length} direct message(s) older than ${days} days`,
      );
    }
  }

  private async retentionDays(): Promise<number> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.ChatRetentionDirectDays],
    );

    const days = Number(row?.value);

    return Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS;
  }
}
