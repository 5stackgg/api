import { Module, OnModuleInit } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { PostgresModule } from "src/postgres/postgres.module";
import { RedisModule } from "src/redis/redis.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { ServerRosterQueues } from "./enums/ServerRosterQueues";
import { ServerRosterService } from "./server-roster.service";
import { CommunityStatsService } from "./community-stats.service";
import { ServerRosterController } from "./server-roster.controller";
import { SweepServerRosters } from "./jobs/SweepServerRosters";
import { PruneServerPlayerSessions } from "./jobs/PruneServerPlayerSessions";

@Module({
  imports: [
    PostgresModule,
    RedisModule,
    BullModule.registerQueue({
      name: ServerRosterQueues.ServerRoster,
    }),
    BullBoardModule.forFeature({
      name: ServerRosterQueues.ServerRoster,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    ServerRosterService,
    CommunityStatsService,
    SweepServerRosters,
    PruneServerPlayerSessions,
    ...getQueuesProcessors("ServerRoster"),
    loggerFactory(),
  ],
  exports: [ServerRosterService],
  controllers: [ServerRosterController],
})
export class ServerRosterModule implements OnModuleInit {
  constructor(
    @InjectQueue(ServerRosterQueues.ServerRoster)
    private readonly queue: Queue,
  ) {}

  public onModuleInit() {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void this.queue.add(
      SweepServerRosters.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void this.queue.add(
      PruneServerPlayerSessions.name,
      {},
      {
        repeat: {
          pattern: "41 * * * *",
        },
      },
    );
  }
}
