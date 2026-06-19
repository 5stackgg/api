import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import { NotificationsService } from "../notifications.service";

@UseQueue("Notifications", NotificationsQueues.SanctionNotifications)
export class SendSanctionNotifications extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(
    job: Job<{
      sanctionId: string;
      steamId: string;
      type: string;
      reason?: string | null;
    }>,
  ): Promise<void> {
    await this.notifications.notifyBannedPlayer(job.data);
    await this.notifications.notifyMatchPlayersOfSanction(job.data);
    await this.notifications.notifyAdminsOfBan(job.data);
  }
}
