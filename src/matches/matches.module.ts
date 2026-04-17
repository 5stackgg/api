import {
  forwardRef,
  MiddlewareConsumer,
  Logger,
  Module,
  NestModule,
  RequestMethod,
} from "@nestjs/common";
import { MatchesController } from "./matches.controller";
import { MatchAssistantService } from "./match-assistant/match-assistant.service";
import { HasuraModule } from "../hasura/hasura.module";
import { RconModule } from "../rcon/rcon.module";
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
import { StopOnDemandServer } from "./jobs/StopOnDemandServer";
import { MatchRelayController } from "./match-relay/match-relay.controller";
import { MatchRelayService } from "./match-relay/match-relay.service";
import { MatchRelayAuthMiddleware } from "./match-relay/match-relay-auth-middleware";
import { K8sModule } from "src/k8s/k8s.module";
import { DiscordTournamentVoiceModule } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.module";

@Module({
  imports: [
    HasuraModule,
    forwardRef(() => RconModule),
    CacheModule,
    RedisModule,
    S3Module,
    EncryptionModule,
    SocketsModule,
    PostgresModule,
    NotificationsModule,
    K8sModule,
    forwardRef(() => DiscordBotModule),
    DiscordTournamentVoiceModule,
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
        name: MatchQueues.EloCalculation,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
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
        name: MatchQueues.EloCalculation,
        adapter: BullMQAdapter,
      },
    ),
  ],
  controllers: [MatchesController, MatchRelayController],
  exports: [MatchAssistantService],
  providers: [
    MatchEventsGateway,
    MatchAssistantService,
    MatchRelayService,
    CheckOnDemandServerJob,
    CheckOnDemandServerJobEvents,
    CancelExpiredMatches,
    CheckForTournamentStart,
    CheckForScheduledMatches,
    RemoveCancelledMatches,
    StopOnDemandServer,
    CancelInvalidTournaments,
    CleanAbandonedMatches,
    EloCalculation,
    ...getQueuesProcessors("Matches"),
    ...Object.values(MatchEvents),
    loggerFactory(),
  ],
})
export class MatchesModule implements NestModule {
  constructor(
    private readonly hasuraService: HasuraService,
    private readonly logger: Logger,
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

    void this.generatePlayerRatings();
  }

  /**
   * Runs once per ELO formula change. Keyed off a settings marker so upgrades
   * that change the ELO math (e.g. best-of series multiplier) re-generate
   * historical rows. Bump SERIES_MULTIPLIER_BACKFILL_MARKER when the formula
   * changes again.
   */
  async generatePlayerRatings() {
    const SERIES_MULTIPLIER_BACKFILL_MARKER =
      "player_elo_backfill_series_multiplier_v1";

    const { settings_by_pk } = await this.hasuraService.query({
      settings_by_pk: {
        __args: { name: SERIES_MULTIPLIER_BACKFILL_MARKER },
        value: true,
      },
    });

    if (settings_by_pk) {
      return;
    }

    await this.postgres.query(`TRUNCATE TABLE player_elo`);

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
        this.logger.error(
          `Failed to generate player ratings for match ${match.id}:`,
          error,
        );
      }
    }

    await this.hasuraService.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: SERIES_MULTIPLIER_BACKFILL_MARKER,
            value: new Date().toISOString(),
          },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });
  }

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(MatchServerMiddlewareMiddleware)
      .forRoutes(
        { path: "matches/current-match/:serverId", method: RequestMethod.ALL },
        { path: "demos/:matchId/*splat", method: RequestMethod.POST },
      );
    consumer.apply(MatchRelayAuthMiddleware).forRoutes(
      {
        path: "match-relay/:id/:token/:fragment/start",
        method: RequestMethod.POST,
      },
      {
        path: "match-relay/:id/:token/:fragment/full",
        method: RequestMethod.POST,
      },
      {
        path: "match-relay/:id/:token/:fragment/delta",
        method: RequestMethod.POST,
      },
    );
  }
}
