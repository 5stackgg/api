import { WorkerHost } from "@nestjs/bullmq";
import { DiscordBotQueues } from "../enums/DiscordBotQueues";
import { DiscordBotVetoService } from "../discord-bot-veto/discord-bot-veto.service";
import { Job } from "bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";

@UseQueue("DiscordBot", DiscordBotQueues.DiscordBot)
export class UpdateDiscordMatchVetoJob extends WorkerHost {
  constructor(private readonly vetoService: DiscordBotVetoService) {
    super();
  }

  async process(
    job: Job<{
      matchId: string;
    }>,
  ): Promise<void> {
    const { matchId } = job.data;
    await this.vetoService.pickVeto(matchId);
    return;
  }
}
