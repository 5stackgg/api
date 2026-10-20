import { Module, OnModuleInit } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import {
  getQueuesProcessors,
  scheduleJobs,
} from "../utilities/QueueProcessors";
import { TwitchQueues } from "./enums/TwitchQueues";
import { TwitchService } from "./twitch.service";
import { TwitchAccountsService } from "./twitch-accounts.service";
import { TwitchController } from "./twitch.controller";
import { TwitchAuthController } from "./twitch-auth.controller";
import { PollTwitchStreams } from "./jobs/PollTwitchStreams";
import { StreamAccessService } from "../matches/game-streamer/stream-access.service";

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
    StreamAccessService,
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

    void scheduleJobs(
      this.queue,
      { [PollTwitchStreams.name]: { pattern: "* * * * *" } },
      { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    );
  }
}
