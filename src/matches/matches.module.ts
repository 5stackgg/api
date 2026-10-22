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
import { PluginRuntimeModule } from "../plugin-runtime/plugin-runtime.module";
import { UtilityModule } from "../utility/utility.module";
import { GamePluginsModule } from "../game-plugins/game-plugins.module";
import { CacheModule } from "../cache/cache.module";
import { RedisModule } from "../redis/redis.module";
import { S3Module } from "../s3/s3.module";
import { DiscordBotModule } from "../discord-bot/discord-bot.module";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { MatchQueues } from "./enums/MatchQueues";
import { TypesenseQueues } from "../type-sense/enums/TypesenseQueues";
import { SteamMatchHistoryQueues } from "../steam-match-history/enums/SteamMatchHistoryQueues";
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
import { AutoPickExpiredVeto } from "./jobs/AutoPickExpiredVeto";
import { RemoveCancelledMatches } from "./jobs/RemoveCancelledMatches";
import { CheckForTournamentStart } from "./jobs/CheckForTournamentStart";
import { CheckForScheduledTournamentBrackets } from "./jobs/CheckForScheduledTournamentBrackets";
import { CheckLeagueSeasonTransitions } from "./jobs/CheckLeagueSeasonTransitions";
import { ApplyLeagueDefaultSchedules } from "./jobs/ApplyLeagueDefaultSchedules";
import { LeagueWeekReminders } from "./jobs/LeagueWeekReminders";
import { TournamentReminders } from "./jobs/TournamentReminders";
import { ProcessTournamentCheckIn } from "./jobs/ProcessTournamentCheckIn";
import { EventReminders } from "./jobs/EventReminders";
import { EncryptionModule } from "../encryption/encryption.module";
import {
  getQueuesProcessors,
  scheduleJobs,
} from "../utilities/QueueProcessors";
import { CancelInvalidTournaments } from "./jobs/CancelInvalidTournaments";
import { SocketsModule } from "../sockets/sockets.module";
import { CleanAbandonedMatches } from "./jobs/CleanAbandonedMatches";
import { ReapIdleDemoSessions } from "./jobs/ReapIdleDemoSessions";
import { ReapOrphanDemoResources } from "./jobs/ReapOrphanDemoResources";
import { ReconcileDeadlines } from "./jobs/ReconcileDeadlines";
import { DeadlinesService } from "./deadlines/deadlines.service";
import { DeadlinesController } from "./deadlines/deadlines.controller";
import { PollMediaMtxViewers } from "./jobs/PollMediaMtxViewers";
import { MonitorMatchCameras } from "./jobs/MonitorMatchCameras";
import { MatchMaking } from "src/matchmaking/matchmaking.module";
import { MatchEventsGateway } from "./match-events.gateway";
import { PostgresModule } from "src/postgres/postgres.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ChatModule } from "src/chat/chat.module";
import { EloCalculation } from "./jobs/EloCalculation";
import { RecomputeAllElo } from "./jobs/RecomputeAllElo";
import { PlayerEloRecomputeService } from "./player-elo-recompute.service";
import { BackfillSeasonElo } from "./jobs/BackfillSeasonElo";
import { SeasonEloBackfillService } from "./season-elo-backfill.service";
import { StopOnDemandServer } from "./jobs/StopOnDemandServer";
import { StopMatchBroadcast } from "./jobs/StopMatchBroadcast";
import { ReconcileOnDemandServerJobs } from "./jobs/ReconcileOnDemandServerJobs";
import { MatchRelayController } from "./match-relay/match-relay.controller";
import { MatchRelayService } from "./match-relay/match-relay.service";
import { MatchRelayAuthMiddleware } from "./match-relay/match-relay-auth-middleware";
import { K8sModule } from "src/k8s/k8s.module";
import { DiscordTournamentVoiceModule } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.module";
import { VoiceModule } from "../voice/voice.module";
import { GameStreamerModule } from "./game-streamer/game-streamer.module";
import { DemosModule } from "../demos/demos.module";
import { ClipsModule } from "./clips/clips.module";
import { SteamMatchHistoryModule } from "../steam-match-history/steam-match-history.module";
import { LeaguesModule } from "../leagues/leagues.module";
import { MediaMtxModule } from "../mediamtx/mediamtx.module";
import { CameraController } from "./camera/camera.controller";
import { CameraService } from "./camera/camera.service";
import { CameraMonitorService } from "./camera/camera-monitor.service";
import { MatchRecoveryController } from "./match-recovery/match-recovery.controller";
import { MatchRecoveryService } from "./match-recovery/match-recovery.service";

@Module({
  imports: [
    HasuraModule,
    MediaMtxModule,
    forwardRef(() => RconModule),
    CacheModule,
    RedisModule,
    S3Module,
    EncryptionModule,
    SocketsModule,
    PostgresModule,
    NotificationsModule,
    K8sModule,
    GameStreamerModule,
    DemosModule,
    ClipsModule,
    forwardRef(() => SteamMatchHistoryModule),
    forwardRef(() => DiscordBotModule),
    DiscordTournamentVoiceModule,
    VoiceModule,
    MatchMaking,
    ChatModule,
    LeaguesModule,
    PluginRuntimeModule,
    forwardRef(() => UtilityModule),
    GamePluginsModule,
    BullModule.registerQueue(
      {
        name: MatchQueues.MatchServers,
      },
      {
        name: MatchQueues.ScheduledMatches,
      },
      {
        name: MatchQueues.Deadlines,
      },
      {
        name: MatchQueues.VetoTimeouts,
      },
      {
        name: MatchQueues.EloCalculation,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      },
      {
        name: MatchQueues.EloRecompute,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      },
      {
        name: MatchQueues.SeasonEloBackfill,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      },
      {
        name: SteamMatchHistoryQueues.CheckSteamBansForMatch,
      },
      {
        name: TypesenseQueues.PlayerReindex,
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
        name: MatchQueues.Deadlines,
        adapter: BullMQAdapter,
      },
      {
        name: MatchQueues.VetoTimeouts,
        adapter: BullMQAdapter,
      },
      {
        name: MatchQueues.EloCalculation,
        adapter: BullMQAdapter,
      },
      {
        name: MatchQueues.EloRecompute,
        adapter: BullMQAdapter,
      },
      {
        name: MatchQueues.SeasonEloBackfill,
        adapter: BullMQAdapter,
      },
    ),
  ],
  controllers: [
    MatchesController,
    MatchRelayController,
    CameraController,
    MatchRecoveryController,
    DeadlinesController,
  ],
  exports: [MatchAssistantService, PlayerEloRecomputeService],
  providers: [
    MatchEventsGateway,
    MatchAssistantService,
    MatchRelayService,
    CameraService,
    CameraMonitorService,
    MatchRecoveryService,
    CheckOnDemandServerJob,
    CheckOnDemandServerJobEvents,
    CancelExpiredMatches,
    AutoPickExpiredVeto,
    CheckForTournamentStart,
    CheckForScheduledTournamentBrackets,
    CheckLeagueSeasonTransitions,
    ApplyLeagueDefaultSchedules,
    LeagueWeekReminders,
    TournamentReminders,
    ProcessTournamentCheckIn,
    EventReminders,
    CheckForScheduledMatches,
    RemoveCancelledMatches,
    StopOnDemandServer,
    StopMatchBroadcast,
    ReconcileOnDemandServerJobs,
    CancelInvalidTournaments,
    CleanAbandonedMatches,
    ReapIdleDemoSessions,
    ReapOrphanDemoResources,
    PollMediaMtxViewers,
    MonitorMatchCameras,
    DeadlinesService,
    ReconcileDeadlines,
    EloCalculation,
    RecomputeAllElo,
    PlayerEloRecomputeService,
    BackfillSeasonElo,
    SeasonEloBackfillService,
    ...getQueuesProcessors("Matches"),
    ...Object.values(MatchEvents),
    loggerFactory(),
  ],
})
export class MatchesModule implements NestModule {
  constructor(
    @InjectQueue(MatchQueues.MatchServers) matchServersQueue: Queue,
    @InjectQueue(MatchQueues.ScheduledMatches) scheduleMatchQueue: Queue,
    @InjectQueue(MatchQueues.Deadlines) deadlinesQueue: Queue,
    @InjectQueue(MatchQueues.VetoTimeouts) vetoTimeoutsQueue: Queue,
    playerEloRecompute: PlayerEloRecomputeService,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scheduleJobs(scheduleMatchQueue, {
      [CheckLeagueSeasonTransitions.name]: { pattern: "*/5 * * * *" },
      [ApplyLeagueDefaultSchedules.name]: { pattern: "0 * * * *" },
      [LeagueWeekReminders.name]: { pattern: "30 * * * *" },
      // Hourly: both windows here are days wide, unlike the tournament 2h one.
      [EventReminders.name]: { pattern: "15 * * * *" },
      // More often than the reminders above, because the 2h window is far
      // tighter than their day-wide ones.
      [TournamentReminders.name]: { pattern: "*/5 * * * *" },
      // A canceled match is deleted a day after it was canceled; nobody waits
      // on the hour.
      [RemoveCancelledMatches.name]: { pattern: "53 * * * *" },
      [ReapIdleDemoSessions.name]: { pattern: "* * * * *" },
      [ReapOrphanDemoResources.name]: { pattern: "*/10 * * * *" },
      [ReconcileOnDemandServerJobs.name]: { pattern: "*/10 * * * *" },
      [PollMediaMtxViewers.name]: { every: 30_000 },
      // Faster than the viewer poll: this one decides whether a live match keeps
      // playing, and the grace window is only 30s.
      [MonitorMatchCameras.name]: { every: 10_000 },
    });

    void scheduleJobs(matchServersQueue, {
      [CleanAbandonedMatches.name]: { pattern: "0 0 * * *" },
    });

    // The deadline sweeps are woken at each deadline by the *_deadlines event
    // triggers (DeadlinesService). This is the backstop for a wake-up that was
    // never armed, and the boot run catches up on whatever came due while the
    // api was down.
    void scheduleJobs(deadlinesQueue, {
      [ReconcileDeadlines.name]: { pattern: "*/5 * * * *" },
    });
    void deadlinesQueue.add(
      ReconcileDeadlines.name,
      {},
      { removeOnComplete: true, removeOnFail: true },
    );

    // Every minute, unlike the reconcile: a timer that fires on time but cannot
    // pick -- a locked row, a failed query -- leaves players on the veto
    // screen, and only a turn already open when the reconcile ran gets armed.
    // Empty payload means no fencing token, so it sweeps anything past its
    // deadline, and the partial index on veto_pick_expires_at keeps it cheap.
    void scheduleJobs(vetoTimeoutsQueue, {
      [AutoPickExpiredVeto.name]: { pattern: "* * * * *" },
    });

    // Bump the marker when the ELO formula changes, so every rating is rebuilt
    // once under it.
    void playerEloRecompute.recomputeOnce(
      "player_elo_backfill_series_multiplier_v1",
    );
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
      {
        path: "game-streamer/:matchId/status",
        method: RequestMethod.POST,
      },
    );
  }
}
