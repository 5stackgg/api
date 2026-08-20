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
  name: string;
  version: string;
  previousVersion: string | null;
  error: string | null;
  outcome: "updated" | "failed";
  nodes: Array<string>;
};

// Whether to notify at all was decided before this was queued. What is left is
// wording it, so there is deliberately no path through here that returns
// without sending: a completed job holds its id for the dedup window, and a
// silent completion would take every later notice for the release with it.
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

    if (notice.outcome === "failed") {
      await this.notifyFailed(notice);
      return;
    }

    await this.notifyUpdated(notice);
  }

  private async notifyUpdated(notice: UpdateNotice): Promise<void> {
    // Counted off previous_version rather than off who is on the new build: a
    // node installing the plugin for the first time is also on it, and it did
    // not update. previous_version is the one column the end of pass inventory
    // report leaves alone, so it still says so by the time this runs.
    //
    // Matched against the version this notice names, too. A fleet does not have
    // to move in step -- some nodes can come off 1.0.0 while others come off
    // 1.1.0 -- and counting both makes the notice claim ten nodes made a jump
    // that four of them did not.
    const [counted] = await this.postgres.query<Array<{ count: string }>>(
      `SELECT count(*) AS count
         FROM public.game_server_node_plugins
        WHERE plugin_slug = $1
          AND version = $2
          AND previous_version = $3`,
      [notice.slug, notice.version, notice.previousVersion],
    );

    // Never below what the payload already knows: the nodes that booked this
    // notice reported the update themselves.
    const nodes = Math.max(Number(counted?.count ?? 0), notice.nodes.length);

    await this.notifications.send(
      "GameNodeStatus",
      {
        entity_id: `game_plugin_updated:${notice.slug}:${notice.version}`,
        title: "Game Plugin Auto-Updated",
        message:
          `${NotificationsService.escapeHtml(notice.name)} auto-updated from ` +
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

  // Read off the payload, not off the plugin's rows. A failed update leaves
  // the previous version sitting on disk, so the inventory report at the end
  // of the same pass writes the row back to Installed at that version with no
  // error -- seconds before this runs. The row cannot be asked what failed;
  // only the node that failed it can say, and it already did.
  private async notifyFailed(notice: UpdateNotice): Promise<void> {
    const nodes = await this.labelled(notice.nodes);

    const named =
      nodes.length > 3
        ? `${nodes.length} nodes`
        : nodes.map((node) => NotificationsService.escapeHtml(node)).join(", ");

    await this.notifications.send(
      "GameNodeStatus",
      {
        entity_id: `game_plugin_update_failed:${notice.slug}:${notice.version}`,
        title: "Game Plugin Update Failed",
        message:
          `${NotificationsService.escapeHtml(notice.name)} could not install ` +
          `${NotificationsService.escapeHtml(notice.version)} on ${named}` +
          `${notice.error ? `: ${NotificationsService.escapeHtml(notice.error)}` : ""}. ` +
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

  // The id is a hostname nobody named; the label is what the panel puts on the
  // node everywhere else, so it is what an admin can match to a machine.
  private async labelled(nodeIds: Array<string>): Promise<Array<string>> {
    if (nodeIds.length === 0) {
      return [];
    }

    const rows = await this.postgres.query<Array<{ label: string }>>(
      `SELECT COALESCE(label, id) AS label
         FROM public.game_server_nodes
        WHERE id = ANY($1::text[])
        ORDER BY COALESCE(label, id)`,
      [nodeIds],
    );

    return rows.length > 0 ? rows.map((row) => row.label) : nodeIds;
  }
}
