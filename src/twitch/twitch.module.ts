import { Module, OnModuleInit } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { TwitchQueues } from "./enums/TwitchQueues";
import { TwitchService } from "./twitch.service";
import { TwitchAccountsService } from "./twitch-accounts.service";
import { TwitchController } from "./twitch.controller";
import { TwitchAuthController } from "./twitch-auth.controller";
import { PollTwitchStreams } from "./jobs/PollTwitchStreams";

@Module({
  imports: [
    PostgresModule,
    RedisModule,
    BullModule.registerQueue({
      name: TwitchQueues.Twitch,
    }),
    BullBoardModule.forFeature({
      name: TwitchQueues.Twitch,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    TwitchService,
    TwitchAccountsService,
    PollTwitchStreams,
    ...getQueuesProcessors("Twitch"),
    loggerFactory(),
  ],
  controllers: [TwitchController, TwitchAuthController],
})
export class TwitchModule implements OnModuleInit {
  constructor(
    @InjectQueue(TwitchQueues.Twitch)
    private readonly queue: Queue,
  ) {}

  public onModuleInit() {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    // Once a minute is one Helix call per hundred linked players.
    void this.queue.add(
      PollTwitchStreams.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600 },
      },
    );
  }
}
