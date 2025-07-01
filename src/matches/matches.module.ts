import {
  forwardRef,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from "@nestjs/common";
import { MatchesController } from "./matches.controller";
import { MatchAssistantService } from "./match-assistant/match-assistant.service";
import { HasuraModule } from "../hasura/hasura.module";
import { RconModule } from "../rcon/rcon.module";
import { DemosController } from "./demos/demos.controller";
import { BackupRoundsController } from "./backup-rounds/backup-rounds.controller";
import { CacheModule } from "../cache/cache.module";
import { RedisModule } from "../redis/redis.module";
import { S3Module } from "../s3/s3.module";
import { DiscordBotModule } from "../discord-bot/discord-bot.module";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { MatchQueues } from "./enums/MatchQueues";
import {
  CheckOnDemandServerJob,
  CheckOnDemandServerJobEvents,
} from "./jobs/CheckOnDemandServerJob";
import { MatchEvents } from "./events";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchServerMiddlewareMiddleware } from "./match-server-middleware/match-server-middleware.middleware";
import { Queue } from "bullmq";
import { CheckForScheduledMatches } from "./jobs/CheckForScheduledMatches";
import { CancelExpiredMatches } from "./jobs/CancelExpiredMatches";
import { RemoveCancelledMatches } from "./jobs/RemoveCancelledMatches";
import { CheckForTournamentStart } from "./jobs/CheckForTournamentStart";
import { EncryptionModule } from "../encryption/encryption.module";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { CancelInvalidTournaments } from "./jobs/CancelInvalidTournaments";
import { SocketsModule } from "../sockets/sockets.module";
import { CleanAbandonedMatches } from "./jobs/CleanAbandonedMatches";
import { MatchMaking } from "src/matchmaking/matchmaking.module";
import { MatchEventsGateway } from "./match-events.gateway";
import { PostgresModule } from "src/postgres/postgres.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ChatModule } from "src/chat/chat.module";
import { HasuraService } from "src/hasura/hasura.service";
import { EloCalculation } from "./jobs/EloCalculation";
import { PostgresService } from "src/postgres/postgres.service";
import { CleanDemos } from "./jobs/CleanDemos";

@Module({
  imports: [
    HasuraModule,
    RconModule,
    CacheModule,
    RedisModule,
    S3Module,
    EncryptionModule,
    SocketsModule,
    PostgresModule,
    NotificationsModule,
    forwardRef(() => DiscordBotModule),
    MatchMaking,
    ChatModule,
    BullModule.registerQueue(
      {
        name: MatchQueues.MatchServers,
      },
      {
        name: MatchQueues.ScheduledMatches,
      },
      {
        name: MatchQueues.CleanDemos,
      },
      {
        name: MatchQueues.EloCalculation,
      },
    ),
    BullBoardModule.forFeature(
      {
        name: MatchQueues.MatchServers,
        adapter: BullMQAdapter,
      },
      {
        name: MatchQueues.ScheduledMatches,
        adapter: BullMQAdapter,
      },
      {
        name: MatchQueues.CleanDemos,
        adapter: BullMQAdapter,
      },
      {
        name: MatchQueues.EloCalculation,
        adapter: BullMQAdapter,
      },
    ),
  ],
  controllers: [MatchesController, DemosController, BackupRoundsController],
  exports: [MatchAssistantService],
  providers: [
    MatchEventsGateway,
    MatchAssistantService,
    CheckOnDemandServerJob,
    CheckOnDemandServerJobEvents,
    CancelExpiredMatches,
    CheckForTournamentStart,
    CheckForScheduledMatches,
    RemoveCancelledMatches,
    CancelInvalidTournaments,
    CleanAbandonedMatches,
    CleanDemos,
    EloCalculation,
    ...getQueuesProcessors("Matches"),
    ...Object.values(MatchEvents),
    loggerFactory(),
  ],
})
export class MatchesModule implements NestModule {
  constructor(
    private readonly hasuraService: HasuraService,
    @InjectQueue(MatchQueues.CleanDemos) cleanDemosQueue: Queue,
    @InjectQueue(MatchQueues.MatchServers) matchServersQueue: Queue,
    @InjectQueue(MatchQueues.ScheduledMatches) scheduleMatchQueue: Queue,
    private readonly postgres: PostgresService,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scheduleMatchQueue.add(
      CheckForScheduledMatches.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void scheduleMatchQueue.add(
      CancelExpiredMatches.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void scheduleMatchQueue.add(
      RemoveCancelledMatches.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void matchServersQueue.add(
      CheckForTournamentStart.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void matchServersQueue.add(
      CleanAbandonedMatches.name,
      {},
      {
        repeat: {
          pattern: "0 0 * * *",
        },
      },
    );

    void matchServersQueue.add(
      CancelInvalidTournaments.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void cleanDemosQueue.add(
      CleanDemos.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );

    void this.generatePlayerRatings();
  }

  /**
   * TODO - this is required one time
   */
  async generatePlayerRatings() {
    const { player_elo_aggregate } = await this.hasuraService.query({
      player_elo_aggregate: {
        aggregate: {
          count: true,
        },
      },
    });

    if (player_elo_aggregate.aggregate.count > 0) {
      return;
    }

    const matches = await this.hasuraService.query({
      matches: {
        __args: {
          where: {
            ended_at: { _is_null: false },
            winning_lineup_id: { _is_null: false },
          },
          order_by: [
            {
              created_at: "asc",
            },
          ],
        },
        id: true,
        created_at: true,
        ended_at: true,
      },
    });

    for (const match of matches.matches) {
      try {
        await this.postgres.query(
          `
          SELECT generate_player_elo_for_match($1)
        `,
          [match.id],
        );
      } catch (error) {
        console.error(
          `Failed to generate player ratings for match ${match.id}:`,
          error,
        );
        // Continue with the next match instead of failing completely
      }
    }
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MatchServerMiddlewareMiddleware).forRoutes(
      { path: "matches/current-match/:serverId", method: RequestMethod.ALL },
      { path: "demos/:matchId/*", method: RequestMethod.POST },
      {
        path: "matches/:matchId/backup-rounds/*",
        method: RequestMethod.POST,
      },
    );
  }
}
