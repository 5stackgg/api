import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { TwitchQueues } from "../enums/TwitchQueues";
import { TwitchAccountsService } from "../twitch-accounts.service";

@UseQueue("Twitch", TwitchQueues.Twitch)
export class PollTwitchStreams extends WorkerHost {
  constructor(private readonly accounts: TwitchAccountsService) {
    super();
  }

  async process(): Promise<void> {
    await this.accounts.pollLiveStatus();
  }
}
