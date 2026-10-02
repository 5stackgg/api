import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import { NotificationsService } from "../notifications.service";

type SanctionNotification = {
  sanctionId: string;
  steamId: string;
  type: string;
  reason?: string | null;
};

@UseQueue("Notifications", NotificationsQueues.SanctionNotifications)
export class SendSanctionNotifications extends WorkerHost {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly logger: Logger,
  ) {
    super();
  }

  // The job runs once and its failed id is kept for an hour, so one notice
  // failing must not cost the others; the co-player fan-out is the largest and
  // goes last.
  async process(job: Job<SanctionNotification>): Promise<void> {
    const steps: Array<
      [string, (data: SanctionNotification) => Promise<void>]
    > = [
      ["banned player", (data) => this.notifications.notifyBannedPlayer(data)],
      ["warned player", (data) => this.notifications.notifyWarnedPlayer(data)],
      ["admins", (data) => this.notifications.notifyAdminsOfBan(data)],
      [
        "co-players",
        (data) => this.notifications.notifyMatchPlayersOfSanction(data),
      ],
    ];

    for (const [name, notify] of steps) {
      try {
        await notify(job.data);
      } catch (error) {
        this.logger.error(
          `failed to notify ${name} of sanction ${job.data.sanctionId} on ${job.data.steamId}`,
          error,
        );
      }
    }
  }
}
