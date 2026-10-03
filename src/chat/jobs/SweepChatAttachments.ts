import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatQueues } from "../enums/ChatQueues";
import { ChatAttachmentsService } from "../chat-attachments.service";

@UseQueue("Chat", ChatQueues.ChatMaintenance)
export class SweepChatAttachments extends WorkerHost {
  constructor(private readonly attachments: ChatAttachmentsService) {
    super();
  }

  async process(_job: Job): Promise<number> {
    await this.attachments.removeExpired();

    return await this.attachments.sweepOrphans();
  }
}
