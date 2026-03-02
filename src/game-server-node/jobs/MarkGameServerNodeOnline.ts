import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class MarkGameServerNodeOnline extends WorkerHost {
  constructor(
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

    await this.notifications.send("GameNodeStatus", {
      message,
      title: "Game Server Node Online",
      role: "administrator",
      entity_id: job.data.node,
    }, undefined, DISCORD_COLORS.GREEN);
  }
}
