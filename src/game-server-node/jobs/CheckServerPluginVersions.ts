import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";
import { PluginRuntimeService } from "src/plugin-runtime/plugin-runtime.service";

@UseQueue("GameServerNode", GameServerQueues.PluginVersion)
export class CheckServerPluginVersions extends WorkerHost {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly notifications: NotificationsService,
    protected readonly pluginRuntimeService: PluginRuntimeService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const { notifications_aggregate } = await this.hasura.query({
      notifications_aggregate: {
        __args: {
          where: {
            entity_id: {
              _eq: "plugin_version",
            },
            is_read: {
              _eq: false,
            },
            deleted_at: {
              _is_null: true,
            },
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    if (notifications_aggregate.aggregate.count > 0) {
      return;
    }

    const runtime = await this.pluginRuntimeService.getPluginRuntime();

    const { plugin_versions } = await this.hasura.query({
      plugin_versions: {
        __args: {
          limit: 1,
          where: {
            runtime: {
              _eq: runtime,
            },
          },
          order_by: [
            {
              published_at: "desc",
            },
          ],
        },
        version: true,
      },
    });

    const plugin_version = plugin_versions.at(0)?.version;

    if (!plugin_version) {
      return;
    }

    const { servers_aggregate } = await this.hasura.query({
      servers_aggregate: {
        __args: {
          where: {
            is_dedicated: {
              _eq: true,
            },
            type: {
              _eq: "Ranked",
            },
            connected: {
              _eq: true,
            },
            // A server known to be on the other framework is waiting to be
            // recycled onto the selected runtime, not running an out of date
            // plugin. A server that has never reported one is assumed to be on
            // the selected runtime so it still gets flagged.
            _or: [
              {
                plugin_runtime: {
                  _eq: runtime,
                },
              },
              {
                plugin_runtime: {
                  _is_null: true,
                },
              },
            ],
            _and: [
              {
                plugin_version: {
                  _neq: plugin_version,
                },
              },
              {
                plugin_version: {
                  _neq: "dev",
                },
              },
            ],
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    if (servers_aggregate.aggregate.count === 0) {
      return;
    }

    await this.notifications.send(
      "DedicatedServerStatus",
      {
        entity_id: "plugin_version",
        message: `${servers_aggregate.aggregate.count} servers has out of date plugins.`,
        title: "Plugin Out of Date",
        role: "administrator",
      },
      undefined,
      DISCORD_COLORS.RED,
    );
  }
}
