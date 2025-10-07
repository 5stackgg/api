import { WorkerHost } from "@nestjs/bullmq";
import { DiscordBotQueues } from "../enums/DiscordBotQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DiscordBotMessagingService } from "../discord-bot-messaging/discord-bot-messaging.service";

@UseQueue("DiscordBot", DiscordBotQueues.DiscordBot)
export class RemoveArchivedThreads extends WorkerHost {
  constructor(private readonly messagingService: DiscordBotMessagingService) {
    super();
  }

  async process(): Promise<void> {
    await this.messagingService.removeArchivedThreads();
    return;
  }
}
