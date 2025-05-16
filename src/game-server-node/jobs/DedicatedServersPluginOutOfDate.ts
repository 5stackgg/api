import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";

@UseQueue("GameServerNode", GameServerQueues.PluginVersion)
export class DedicatedServersPluginOutOfDate extends WorkerHost {
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
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: "plugin_version",
        },
        value: true,
      },
    });

    const { servers_aggregate } = await this.hasura.query({
      servers_aggregate: {
        __args: {
          where: {
            is_dedicated: {
              _eq: true,
            },
            connected: {
              _eq: true,
            },
            plugin_version: {
              _neq: settings_by_pk.value,
            },
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    this.notifications.send("DedicatedServerStatus", {
      message: `${servers_aggregate.aggregate.count} servers has out of date plugins.`,
      title: "Plugin Out of Date",
      role: "administrator",
    });
  }
}
