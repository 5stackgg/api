import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";

@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class MarkGameServerOffline extends WorkerHost {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(
    job: Job<{
      serverId: string;
    }>,
  ): Promise<void> {
    const { update_servers_by_pk } = await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: {
            id: job.data.serverId,
          },
          _set: {
            connected: false,
          },
        },
        label: true,
        is_dedicated: true,
      },
    });

    if (!update_servers_by_pk.is_dedicated) {
      return;
    }

    if (process.env.DEV) {
      return;
    }

    this.notifications.send("DedicatedServerStatus", {
      message: `Dedicated Server (${update_servers_by_pk.label || job.data.serverId}) is Offline.`,
      title: "Dedicated Server Offline",
      role: "administrator",
      entity_id: job.data.serverId,
    });
  }
}
