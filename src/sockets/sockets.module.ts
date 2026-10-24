import { Logger, Module } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { SocketsGateway } from "./sockets.gateway";
import { loggerFactory } from "../utilities/LoggerFactory";
import { RedisModule } from "src/redis/redis.module";
import { MatchMaking } from "src/matchmaking/matchmaking.module";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { SocketsController } from "./sockets.controller";
import { SocketsService } from "./sockets.service";
import { GameStreamerModule } from "src/matches/game-streamer/game-streamer.module";
import { PresenceService } from "./presence.service";
import { SocketQueues } from "./enums/SocketQueues";
import { SweepPresence } from "./jobs/SweepPresence";
import {
  getQueuesProcessors,
  scheduleJobs,
} from "../utilities/QueueProcessors";

@Module({
  exports: [SocketsService],
  imports: [
    RedisModule,
    MatchMaking,
    HasuraModule,
    PostgresModule,
    GameStreamerModule,
    BullModule.registerQueue({
      name: SocketQueues.Presence,
    }),
    BullBoardModule.forFeature({
      name: SocketQueues.Presence,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    SocketsGateway,
    loggerFactory(),
    SocketsService,
    PresenceService,
    SweepPresence,
    ...getQueuesProcessors("Sockets"),
  ],
  controllers: [SocketsController],
})
export class SocketsModule {
  constructor(
    private readonly logger: Logger,
    @InjectQueue(SocketQueues.Presence) presenceQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scheduleJobs(presenceQueue, {
      [SweepPresence.name]: { every: 60_000 },
    });
  }
}
