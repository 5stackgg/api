import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ServerRosterQueues } from "../enums/ServerRosterQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { ServerRosterService } from "../server-roster.service";

// Closes the sessions of servers whose plugin stopped reporting -- the server
// died, was disabled, or lost the plugin -- at the moment each was last heard
// from. Three minutes matches the web's "plugin not detected" threshold.
@UseQueue("ServerRoster", ServerRosterQueues.ServerRoster)
export class SweepServerRosters extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly roster: ServerRosterService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const closed = await this.postgres.query<Array<{ server_id: string }>>(
      `SELECT closed.server_id::text AS server_id
         FROM public.close_stale_server_player_sessions(interval '3 minutes') AS closed(server_id)`,
    );

    if (closed.length === 0) {
      return;
    }

    const serverIds = closed.map((row) => row.server_id);

    await this.roster.clearCounts(serverIds);
    await this.roster.rosterChanged(serverIds);

    this.logger.log(
      `closed the sessions of ${closed.length} server(s) whose roster went quiet`,
    );
  }
}
