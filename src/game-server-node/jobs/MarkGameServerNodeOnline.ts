import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class MarkGameServerNodeOnline extends WorkerHost {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(
    job: Job<{
      node: string;
      label?: string;
      offlineAt?: string;
    }>,
  ): Promise<void> {
    const nodeLabel = job.data.label || job.data.node;
    let message = `Game Server Node (${nodeLabel}) is back Online.`;

    if (job.data.offlineAt) {
      const offlineDuration = Math.round(
        (Date.now() - new Date(job.data.offlineAt).getTime()) / 60000,
      );
      if (offlineDuration > 0) {
        message += ` Was offline for ${offlineDuration} minute${offlineDuration !== 1 ? "s" : ""}.`;
      }
    }

    await this.notifications.send(
      "GameNodeStatus",
      {
        message,
        title: "Game Server Node Online",
        role: "administrator",
        entity_id: job.data.node,
      },
      undefined,
      DISCORD_COLORS.GREEN,
    );

    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: job.data.node },
        region: true,
      },
    });

    const region = game_server_nodes_by_pk?.region;
    if (!region) {
      return;
    }

    const { server_regions_by_pk } = await this.hasura.query({
      server_regions_by_pk: {
        __args: { value: region },
        value: true,
        description: true,
        status: true,
      },
    });

    if (
      !server_regions_by_pk ||
      server_regions_by_pk.status === "Offline" ||
      server_regions_by_pk.status === "Disabled"
    ) {
      return;
    }

    await this.hasura.mutation({
      update_notifications: {
        __args: {
          where: {
            type: { _eq: "GameNodeStatus" },
            title: { _eq: "Region Offline" },
            entity_id: { _eq: region },
            deleted_at: { _is_null: true },
          },
          _set: { deletable: true },
        },
        __typename: true,
      },
    });

    await this.notifications.send(
      "GameNodeStatus",
      {
        message: `Region ${server_regions_by_pk.description || region} is back Online (status: ${server_regions_by_pk.status}).`,
        title: "Region Online",
        role: "administrator",
        entity_id: region,
      },
      undefined,
      DISCORD_COLORS.GREEN,
    );
  }
}
