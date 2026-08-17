import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import { PushNotificationsService } from "../push/push-notifications.service";

// The trailing edge of a bundling window.
//
// The first message of a burst is pushed on arrival; everything after it is
// held, and this is what closes the window and replaces that first notification
// with one summary. Scheduled with a jobId scoped to the window's token, so a
// burst produces exactly one of these however many messages it contained.
@UseQueue("Notifications", NotificationsQueues.PushDelivery)
export class SendPushDelivery extends WorkerHost {
  constructor(private readonly pushNotifications: PushNotificationsService) {
    super();
  }

  async process(
    job: Job<{
      steamId: string;
      thread: string;
    }>,
  ): Promise<void> {
    await this.pushNotifications.sendPending(job.data.steamId, job.data.thread);
  }
}
