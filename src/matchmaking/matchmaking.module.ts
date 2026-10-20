import { forwardRef, Module, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchmakingGateway } from "./matchmaking.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RedisModule } from "src/redis/redis.module";
import { CacheModule } from "src/cache/cache.module";
import { MatchesModule } from "src/matches/matches.module";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import {
  getQueuesProcessors,
  scheduleJobs,
} from "src/utilities/QueueProcessors";
import { MatchmakingQueues } from "./enums/MatchmakingQueues";
import { CancelMatchMaking } from "./jobs/CancelMatchMaking";
import { MatchmakingController } from "./matchmaking.controller";
import { MarkPlayerOffline } from "./jobs/MarkPlayerOffline";
import { ExpandMatchmaking } from "./jobs/ExpandMatchmaking";
import { HealStrandedLobbies } from "./jobs/HealStrandedLobbies";
import { NotificationsModule } from "src/notifications/notifications.module";

@Module({
  imports: [
    RedisModule,
    HasuraModule,
    CacheModule,
    NotificationsModule,
    forwardRef(() => MatchesModule),
    BullModule.registerQueue({
      name: MatchmakingQueues.Matchmaking,
    }),
    BullBoardModule.forFeature({
      name: MatchmakingQueues.Matchmaking,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [MatchmakeService, MatchmakingLobbyService],
  providers: [
    MatchmakingGateway,
    MatchmakeService,
    MatchmakingLobbyService,
    CancelMatchMaking,
    MarkPlayerOffline,
    ExpandMatchmaking,
    HealStrandedLobbies,
    ...getQueuesProcessors("Matchmaking"),
    loggerFactory(),
  ],
  controllers: [MatchmakingController],
})
export class MatchMaking implements OnModuleInit {
  constructor(
    @InjectQueue(MatchmakingQueues.Matchmaking)
    private readonly queue: Queue,
  ) {}

  public onModuleInit() {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scheduleJobs(
      this.queue,
      { [HealStrandedLobbies.name]: { pattern: "* * * * *" } },
      { removeOnComplete: true, removeOnFail: true },
    );
  }
}
