import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { DelayedError, Job } from "bullmq";
import { Redis } from "ioredis";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";

type OfflineServer = {
  enabled: boolean;
  is_dedicated: boolean;
  game_server_node?: {
    status: string;
  } | null;
};

@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class MarkDedicatedServerOffline extends WorkerHost {
  // A server restarted on purpose is quiet for as long as it takes to boot, so
  // its down alerts wait this out; one that never comes back is still reported.
  public static readonly RESTART_GRACE_MS = 5 * 60 * 1000;

  private redis: Redis;

  constructor(
    protected readonly hasura: HasuraService,
    protected readonly notifications: NotificationsService,
    redisManager: RedisManagerService,
  ) {
    super();
    this.redis = redisManager.getConnection();
  }

  async process(
    job: Job<{
      serverId: string;
    }>,
  ): Promise<void> {
    const grace = await MarkDedicatedServerOffline.restartGraceRemaining(
      this.redis,
      job.data.serverId,
    );

    if (grace > 0) {
      await job.moveToDelayed(Date.now() + grace + 5 * 1000, job.token);
      throw new DelayedError();
    }

    const { update_servers_by_pk } = await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: {
            id: job.data.serverId,
          },
          _set: {
            connected: false,
            offline_at: new Date().toISOString(),
          },
        },
        label: true,
        enabled: true,
        is_dedicated: true,
        game_server_node: {
          status: true,
        },
      },
    });

    if (!MarkDedicatedServerOffline.shouldNotify(update_servers_by_pk)) {
      return;
    }

    await this.notifications.send(
      "DedicatedServerStatus",
      {
        message: `Dedicated Server (${NotificationsService.escapeHtml(update_servers_by_pk.label || job.data.serverId)}) is Offline.`,
        title: "Dedicated Server Offline",
        role: "administrator",
        entity_id: job.data.serverId,
      },
      undefined,
      DISCORD_COLORS.RED,
    );
  }

  public static async expectRestart(
    redis: Redis,
    serverId: string,
  ): Promise<void> {
    await redis.set(
      MarkDedicatedServerOffline.restartGraceKey(serverId),
      "1",
      "PX",
      MarkDedicatedServerOffline.RESTART_GRACE_MS,
    );
  }

  public static async restartGraceRemaining(
    redis: Redis,
    serverId: string,
  ): Promise<number> {
    const remaining = await redis.pttl(
      MarkDedicatedServerOffline.restartGraceKey(serverId),
    );

    return Math.max(remaining, 0);
  }

  private static restartGraceKey(serverId: string): string {
    return `dedicated-servers:restarting:${serverId}`;
  }

  // A node-hosted dedicated server waits out the node's own 90s timer (the node
  // pings every 30s, plugins every 15s), so when the whole node dies it is
  // already marked Offline and shouldNotify leaves the outage to the node.
  public static delayFor(server: {
    is_dedicated: boolean;
    game_server_node_id: string | null;
  }): number {
    if (server.is_dedicated && server.game_server_node_id) {
      return 120 * 1000;
    }

    return 90 * 1000;
  }

  // Disabling a server tears it down on purpose. A server on a node that is
  // down is the node's outage, which the node reports: a node hosting an enabled
  // dedicated server always counts as in service.
  public static shouldNotify(server: OfflineServer | null): boolean {
    if (!server?.is_dedicated || !server.enabled) {
      return false;
    }

    return server.game_server_node?.status !== "Offline";
  }
}
