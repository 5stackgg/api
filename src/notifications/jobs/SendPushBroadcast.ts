import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import { PushNotificationsService } from "../push/push-notifications.service";

// A fan-out notification writes one row per player, and the Hasura event
// trigger fires for every one of them. Each of those enqueues this job under
// the same jobId, so all but the first are dropped and the survivor resolves
// every recipient in one pass.
@UseQueue("Notifications", NotificationsQueues.PushBroadcast)
export class SendPushBroadcast extends WorkerHost {
  constructor(private readonly pushNotifications: PushNotificationsService) {
    super();
  }

  async process(
    job: Job<{
      type: string;
      entityId: string;
    }>,
  ): Promise<void> {
    await this.pushNotifications.sendForBatch(job.data.type, job.data.entityId);
  }
}
