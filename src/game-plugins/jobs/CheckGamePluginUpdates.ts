import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GamePluginQueues } from "../enums/GamePluginQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { HasuraService } from "../../hasura/hasura.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

type OutdatedInstall = {
  plugin_slug: string;
  name: string;
  installed: string;
  latest: string;
};

@UseQueue("GamePlugins", GamePluginQueues.Registry)
export class CheckGamePluginUpdates extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly postgres: PostgresService,
    protected readonly hasura: HasuraService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    // Only pinned installs can fall behind. An Auto install has no version to
    // compare: it resolves to the newest release every time a node asks, so it
    // is already up to date by construction -- which is why this notifies rather
    // than installing anything.
    const outdated = await this.postgres.query<Array<OutdatedInstall>>(
      `SELECT i.plugin_slug,
              p.name,
              i.version AS installed,
              latest.version AS latest
         FROM public.game_plugin_installs i
         INNER JOIN public.game_plugins p ON p.slug = i.plugin_slug
         CROSS JOIN LATERAL (
           SELECT v.version
             FROM public.game_plugin_versions v
            WHERE v.plugin_slug = i.plugin_slug
              AND v.runtime = active_plugin_runtime()
              AND v.prerelease = false
            ORDER BY v.published_at DESC
            LIMIT 1
         ) latest
        WHERE i.enabled = true
          AND i.channel = 'Pinned'
          AND i.version IS DISTINCT FROM latest.version`,
    );

    if (outdated.length === 0) {
      return;
    }

    // One unread notification stands for the whole backlog, matching how an out
    // of date server plugin is reported; a fresh one is only raised once the
    // admin has cleared the last.
    const { notifications_aggregate } = await this.hasura.query({
      notifications_aggregate: {
        __args: {
          where: {
            entity_id: { _eq: "game_plugin_update" },
            is_read: { _eq: false },
            deleted_at: { _is_null: true },
          },
        },
        aggregate: { count: true },
      },
    });

    if (notifications_aggregate.aggregate.count > 0) {
      return;
    }

    const names = [...new Set(outdated.map((row) => row.name))];

    await this.notifications.send(
      "GameNodeStatus",
      {
        entity_id: "game_plugin_update",
        title: "Game Plugin Updates Available",
        message:
          names.length === 1
            ? `${names[0]} has a newer release than the version installed.`
            : `${names.length} game plugins have newer releases than the versions installed.`,
        role: "administrator",
      },
      undefined,
      DISCORD_COLORS.ORANGE,
    );
  }
}
