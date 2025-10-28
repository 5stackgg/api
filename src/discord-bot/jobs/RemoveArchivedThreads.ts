import { WorkerHost } from "@nestjs/bullmq";
import { DiscordBotQueues } from "../enums/DiscordBotQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DiscordBotMessagingService } from "../discord-bot-messaging/discord-bot-messaging.service";
import { forwardRef, Inject } from "@nestjs/common";

@UseQueue("DiscordBot", DiscordBotQueues.DiscordBot)
export class RemoveArchivedThreads extends WorkerHost {
  constructor(
    @Inject(forwardRef(() => DiscordBotMessagingService))
    private readonly messagingService: DiscordBotMessagingService,
  ) {
    super();
  }

  async process(): Promise<void> {
    await this.messagingService.removeArchivedThreads();
    return;
  }
}
