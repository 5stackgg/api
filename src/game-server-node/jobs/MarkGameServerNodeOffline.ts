import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";

@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class MarkGameServerNodeOffline extends WorkerHost {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(
    job: Job<{
      node: string;
    }>,
  ): Promise<void> {
    const { update_game_server_nodes_by_pk } = await this.hasura.mutation({
      update_game_server_nodes_by_pk: {
        __args: {
          pk_columns: {
            id: job.data.node,
          },
          _set: {
            status: "Offline",
          },
        },
        label: true,
      },
    });

    if (process.env.DEV) {
      return;
    }

    this.notifications.send("GameNodeStatus", {
      message: `Game Server Node (${update_game_server_nodes_by_pk.label || job.data.node}) is Offline.`,
      title: "Game Server Node Offline",
      role: "system_administrator",
      entity_id: job.data.node,
    });
  }
}
