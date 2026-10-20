import {
  Logger,
  MiddlewareConsumer,
  Module,
  OnApplicationBootstrap,
  RequestMethod,
} from "@nestjs/common";
import { GameServerNodeService } from "./game-server-node.service";
import { GameServerNodeController } from "./game-server-node.controller";
import { TailscaleModule } from "../tailscale/tailscale.module";
import { HasuraModule } from "../hasura/hasura.module";
import { CacheModule } from "../cache/cache.module";
import { CheckGameUpdate } from "./jobs/CheckGameUpdate";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { GameServerQueues } from "./enums/GameServerQueues";
import { MarkGameServerNodeOffline } from "./jobs/MarkGameServerNodeOffline";
import { MarkGameServerNodeOnline } from "./jobs/MarkGameServerNodeOnline";
import {
  getQueuesProcessors,
  scheduleJobs,
} from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchServerMiddlewareMiddleware } from "../matches/match-server-middleware/match-server-middleware.middleware";
import { MarkDedicatedServerOffline } from "./jobs/MarkDedicatedServerOffline";
import { RedisModule } from "src/redis/redis.module";
import { NotificationsModule } from "src/notifications/notifications.module";
import { RconModule } from "src/rcon/rcon.module";
import { CheckServerPluginVersions } from "./jobs/CheckServerPluginVersions";
import { HasuraService } from "src/hasura/hasura.service";
import { GetPluginVersions } from "./jobs/GetPluginVersions";
import { K8sModule } from "src/k8s/k8s.module";
import { GameStreamerModule } from "../matches/game-streamer/game-streamer.module";
import { PluginRuntimeModule } from "src/plugin-runtime/plugin-runtime.module";
import { GamePluginsModule } from "src/game-plugins/game-plugins.module";
import { BakeShaders } from "./jobs/BakeShaders";
import { ValidateGamedata } from "./jobs/ValidateGamedata";
import { CleanupRemovedNodes } from "./jobs/CleanupRemovedNodes";
import { ReconcileUpdateStatuses } from "./jobs/ReconcileUpdateStatuses";
import { ReconcileCs2BuildRuns } from "./jobs/ReconcileCs2BuildRuns";
import { MapAssetsModule } from "src/map-assets/map-assets.module";
import { PostgresModule } from "src/postgres/postgres.module";

@Module({
  providers: [
    GameServerNodeService,
    CheckGameUpdate,
    GetPluginVersions,
    MarkGameServerNodeOffline,
    MarkGameServerNodeOnline,
    MarkDedicatedServerOffline,
    CheckServerPluginVersions,
    BakeShaders,
    ValidateGamedata,
    CleanupRemovedNodes,
    ReconcileUpdateStatuses,
    ReconcileCs2BuildRuns,
    ...getQueuesProcessors("GameServerNode"),
    loggerFactory(),
  ],
  imports: [
    RedisModule,
    TailscaleModule,
    HasuraModule,
    CacheModule,
    NotificationsModule,
    RconModule,
    K8sModule,
    GameStreamerModule,
    PluginRuntimeModule,
    GamePluginsModule,
    MapAssetsModule,
    PostgresModule,
    BullModule.registerQueue(
      {
        name: GameServerQueues.GameUpdate,
      },
      {
        name: GameServerQueues.NodeOffline,
      },
      {
        name: GameServerQueues.PluginVersion,
      },
      {
        name: GameServerQueues.BakeShaders,
      },
      {
        name: GameServerQueues.ValidateGamedata,
      },
    ),
    BullBoardModule.forFeature(
      {
        name: GameServerQueues.GameUpdate,
        adapter: BullMQAdapter,
      },
      {
        name: GameServerQueues.NodeOffline,
        adapter: BullMQAdapter,
      },
      {
        name: GameServerQueues.PluginVersion,
        adapter: BullMQAdapter,
      },
      {
        name: GameServerQueues.BakeShaders,
        adapter: BullMQAdapter,
      },
      {
        name: GameServerQueues.ValidateGamedata,
        adapter: BullMQAdapter,
      },
    ),
  ],
  exports: [GameServerNodeService],
  controllers: [GameServerNodeController],
})
export class GameServerNodeModule implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(GameServerQueues.GameUpdate) queue: Queue,
    private readonly hasura: HasuraService,
    private readonly gameServerNodeService: GameServerNodeService,
    private readonly logger: Logger,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scheduleJobs(queue, {
      [CheckGameUpdate.name]: { pattern: "*/6 * * * *" },
      [GetPluginVersions.name]: { pattern: "*/5 * * * *" },
      [CheckServerPluginVersions.name]: { pattern: "*/5 * * * *" },
      [CleanupRemovedNodes.name]: { pattern: "*/5 * * * *" },
      [ReconcileUpdateStatuses.name]: { pattern: "*/10 * * * *" },
    });

    // A burst of restarts pushes the sweep back to the last one.
    void queue
      .remove(ReconcileCs2BuildRuns.JOB_ID)
      .catch(() => 0)
      .then(() =>
        queue.add(
          ReconcileCs2BuildRuns.name,
          {},
          {
            jobId: ReconcileCs2BuildRuns.JOB_ID,
            delay: ReconcileCs2BuildRuns.DELAY_MS,
            removeOnComplete: true,
            removeOnFail: true,
          },
        ),
      );
  }

  public async onApplicationBootstrap() {
    // Clear any open disk-space alerts on boot. If the underlying disk is
    // still over threshold, the next ping re-creates the alert within ~30s;
    // if the node is gone, the stale alert disappears for good.
    try {
      await this.hasura.mutation({
        update_notifications: {
          __args: {
            where: {
              type: { _eq: "GameNodeStatus" },
              title: {
                _in: [
                  "Game Server Node Disk Space Critical",
                  "Game Server Node Low Disk Space",
                ],
              },
              deleted_at: { _is_null: true },
            },
            _set: { deleted_at: new Date().toISOString() },
          },
          __typename: true,
        },
      });
    } catch (error) {
      this.logger.warn(
        `unable to clear disk space alerts on boot: ${(error as Error)?.message}`,
      );
    }

    // Every pod at boot, unlike the schedule: a monitor lives in the process
    // that attached it, so each restart has to re-attach its own.
    void this.gameServerNodeService.reconcileUpdateStatuses();
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MatchServerMiddlewareMiddleware).forRoutes({
      path: "game-server-node/ping/:serverId",
      method: RequestMethod.GET,
    });
  }
}
