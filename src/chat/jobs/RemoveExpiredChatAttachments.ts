import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatQueues } from "../enums/ChatQueues";
import { ChatAttachmentsService } from "../chat-attachments.service";

// Room files whose room has let go of their message, and uploads never sent.
@UseQueue("Chat", ChatQueues.ChatMaintenance)
export class RemoveExpiredChatAttachments extends WorkerHost {
  constructor(private readonly attachments: ChatAttachmentsService) {
    super();
  }

  async process(_job: Job): Promise<number> {
    return await this.attachments.removeExpired();
  }
}
