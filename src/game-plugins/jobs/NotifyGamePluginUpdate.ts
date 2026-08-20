import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GamePluginQueues } from "../enums/GamePluginQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

type UpdateNotice = {
  slug: string;
  version: string;
  previousVersion: string | null;
  outcome: "updated" | "failed";
  nodeId: string;
};

@UseQueue("GamePlugins", GamePluginQueues.Registry)
export class NotifyGamePluginUpdate extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly postgres: PostgresService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<UpdateNotice>): Promise<void> {
    const notice = job.data;

    const [install] = await this.postgres.query<
      Array<{ name: string; channel: string }>
    >(
      `SELECT p.name, i.channel
         FROM public.game_plugin_installs i
         INNER JOIN public.game_plugins p ON p.slug = i.plugin_slug
        WHERE i.plugin_slug = $1 AND i.enabled = true`,
      [notice.slug],
    );

    // Uninstalled between the report and this running, thirty seconds later.
    if (!install) {
      return;
    }

    if (notice.outcome === "failed") {
      await this.notifyFailed(notice, install.name);
      return;
    }

    // A pinned install only changes version because an admin changed it, and
    // they do not need telling what they just did. The whole point of the
    // notice is the version that moved on its own.
    if (install.channel !== "Auto") {
      return;
    }

    await this.notifyUpdated(notice, install.name);
  }

  private async notifyUpdated(
    notice: UpdateNotice,
    name: string,
  ): Promise<void> {
    const [{ count }] = await this.postgres.query<Array<{ count: string }>>(
      `SELECT count(*) AS count
         FROM public.game_server_node_plugins
        WHERE plugin_slug = $1 AND version = $2 AND status = 'Installed'`,
      [notice.slug, notice.version],
    );

    const nodes = Number(count);

    await this.notifications.send(
      "GameNodeStatus",
      {
        title: "Game Plugin Auto-Updated",
        message:
          `${NotificationsService.escapeHtml(name)} auto-updated from ` +
          `${NotificationsService.escapeHtml(notice.previousVersion)} to ` +
          `${NotificationsService.escapeHtml(notice.version)} on ` +
          `${nodes === 1 ? "1 node" : `${nodes} nodes`}. ` +
          `<a href="/plugins/${encodeURIComponent(notice.slug)}">View plugin</a>`,
        role: "administrator",
      },
      undefined,
      DISCORD_COLORS.ORANGE,
    );
  }

  private async notifyFailed(
    notice: UpdateNotice,
    name: string,
  ): Promise<void> {
    const failed = await this.postgres.query<
      Array<{ game_server_node_id: string; last_error: string | null }>
    >(
      `SELECT game_server_node_id, last_error
         FROM public.game_server_node_plugins
        WHERE plugin_slug = $1 AND version = $2 AND status = 'Failed'
        ORDER BY game_server_node_id`,
      [notice.slug, notice.version],
    );

    // It recovered on a retry while this sat in its delay -- converge() runs
    // every five minutes, so that is a real outcome rather than a race.
    if (failed.length === 0) {
      return;
    }

    const error = failed.find((node) => node.last_error)?.last_error;

    const nodes =
      failed.length > 3
        ? `${failed.length} nodes`
        : failed
            .map((node) =>
              NotificationsService.escapeHtml(node.game_server_node_id),
            )
            .join(", ");

    await this.notifications.send(
      "GameNodeStatus",
      {
        title: "Game Plugin Update Failed",
        message:
          `${NotificationsService.escapeHtml(name)} could not install ` +
          `${NotificationsService.escapeHtml(notice.version)} on ${nodes}` +
          `${error ? `: ${NotificationsService.escapeHtml(error)}` : ""}. ` +
          (notice.previousVersion
            ? `They are still running ${NotificationsService.escapeHtml(notice.previousVersion)}. `
            : "") +
          `<a href="/plugins/${encodeURIComponent(notice.slug)}">View plugin</a>`,
        role: "administrator",
      },
      undefined,
      DISCORD_COLORS.RED,
    );
  }
}
