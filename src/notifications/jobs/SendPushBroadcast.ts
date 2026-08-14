import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import { PushNotificationsService } from "../push/push-notifications.service";

// A fan-out notification writes one row per player, and the Hasura event
// trigger fires for every one of them.
//
// Two ways in. A writer that knows the rows it inserted queues `ids` and claims
// them, so the per-row events fall through entirely. Everything else arrives
// from those events, deduped down to one job by jobId, and resolves recipients
// from the (type, entity_id) window instead.
@UseQueue("Notifications", NotificationsQueues.PushBroadcast)
export class SendPushBroadcast extends WorkerHost {
  constructor(private readonly pushNotifications: PushNotificationsService) {
    super();
  }

  async process(
    job: Job<{
      type?: string;
      entityId?: string;
      ids?: string[];
    }>,
  ): Promise<void> {
    if (job.data.ids?.length) {
      await this.pushNotifications.sendForIds(job.data.ids);
      return;
    }

    await this.pushNotifications.sendForBatch(job.data.type, job.data.entityId);
  }
}
