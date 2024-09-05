import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { e_game_server_node_regions_enum, e_match_types_enum } from "generated";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { v4 as uuidv4 } from "uuid";
import { HasuraService } from "src/hasura/hasura.service";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { FiveStackWebSocketClient } from "./server.gateway";

@WebSocketGateway({
  path: "/ws",
})
export class MatchMakingService {
  private redis: Redis;

  constructor(
    private readonly hasura: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  protected static MATCH_MAKING_QUEUE_KEY(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
    return `match-making:v14:${region}:${type}`;
  }

  protected static MATCH_MAKING_CONFIRMATION_KEY(matchId: string) {
    return `match-making:v14:${matchId}`;
  }

  protected static MATCH_MAKING_USER_QUEUE_KEY(steamId: string) {
    return `match-making:v14:user:${steamId}`;
  }

  @SubscribeMessage("match-making:join")
  async joinQueue(
    @MessageBody()
    data: {
      type: e_match_types_enum;
      region: e_game_server_node_regions_enum;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const user = client.user;
    const { type, region } = data;

    if (!type || !region) {
      return;
    }

    const matchMakingQueueKey = MatchMakingService.MATCH_MAKING_QUEUE_KEY(
      type,
      region,
    );

    const existingUserInQueue = await this.redis.zscore(
      matchMakingQueueKey,
      user.steam_id,
    );

    if (existingUserInQueue !== null) {
      return { success: false, message: "Already in queue" };
    }

    const currentTimestamp = Date.now();

    await this.redis.zadd(matchMakingQueueKey, currentTimestamp, user.steam_id);

    const userQueueKey = MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(
      user.steam_id,
    );
    const existingQueues = JSON.parse(
      (await this.redis.hget(userQueueKey, "data")) || "[]",
    );
    const newQueue = { type, region, joinedAt: new Date().toISOString() };

    const queueIndex = existingQueues.findIndex(
      (queue: {
        type: e_match_types_enum;
        region: e_game_server_node_regions_enum;
      }) => {
        return queue.type === type && queue.region === region;
      },
    );

    if (queueIndex === -1) {
      existingQueues.push(newQueue);
    } else {
      existingQueues[queueIndex] = newQueue;
    }

    await this.redis.hset(userQueueKey, "data", JSON.stringify(existingQueues));

    await this.sendJoinedQueuedsToUser(user.steam_id);
    await this.sendRegionStats();

    this.matchmake(type, region);
  }

  @SubscribeMessage("match-making:confirm")
  async confirmMatchMaking(
    @MessageBody()
    data: {
      confirmationId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const user = client.user;
    const { confirmationId } = data;

    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      user.steam_id,
      "true",
    );

    const totalPlayers = await this.redis.hvals(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    );
    const confirmedPlayers = totalPlayers.filter((value) => value === "true");

    const type = await this.redis.hget(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "type",
    );
    const region = await this.redis.hget(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "region",
    );

    const players = await this.redis.hkeys(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    );

    for (const steamId of players) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId,
          event: "match-making:confirmation",
          data: {
            type,
            region,
            confirmationId,
            totalConfirmed: confirmedPlayers.length,
          },
        }),
      );
    }

    if (confirmedPlayers.length === totalPlayers.length) {
      const match = await this.matchAssistant.createMatchBasedOnType(
        type as e_match_types_enum,
        // TODO - get map pool by type
        "Competitive",
        {
          mr: 12,
          region: region as e_game_server_node_regions_enum,
          best_of: 1,
          knife: true,
          overtime: true,
        },
      );

      for (const steamId of players) {
        await this.redis.publish(
          `send-message-to-steam-id`,
          JSON.stringify({
            steamId,
            event: "match-making:match-created",
            data: {
              matchId: match.id,
            },
          }),
        );
      }

      await this.matchAssistant.updateMatchStatus(match.id, "Veto");
    }
  }

  @SubscribeMessage("match-making:leave")
  async leaveQueue(
    @MessageBody()
    data: {
      type: e_match_types_enum;
      region: e_game_server_node_regions_enum;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const user = client.user;
    const { type, region } = data;

    await this.redis.zrem(
      MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
      0,
      user.steam_id,
    );

    const userQueueKey = MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(
      user.steam_id,
    );

    const existingQueues = JSON.parse(
      (await this.redis.hget(userQueueKey, "data")) || "[]",
    );

    const queueIndex = existingQueues.findIndex(
      (queue: {
        type: e_match_types_enum;
        region: e_game_server_node_regions_enum;
      }) => {
        return queue.type === type && queue.region === region;
      },
    );

    if (queueIndex === -1) {
      return;
    }

    existingQueues.splice(queueIndex, 1);

    await this.redis.hset(userQueueKey, "data", JSON.stringify(existingQueues));

    await this.sendRegionStats();
    await this.sendJoinedQueuedsToUser(user.steam_id);
    await this.sendJoinedQueuesToAllUsers(type, region);
  }

  public async getQueueLength(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
    return this.redis.zcard(
      MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
    );
  }

  public async sendRegionStats(user?: User) {
    const regions = await this.hasura.query({
      e_game_server_node_regions: {
        __args: {
          where: {
            game_server_nodes: {
              enabled: {
                _eq: true,
              },
            },
            game_server_nodes_aggregate: {
              count: {
                predicate: {
                  _gt: 0,
                },
              },
            },
          },
        },
        value: true,
      },
    });

    const regionStats: Partial<
      Record<
        e_game_server_node_regions_enum,
        Partial<Record<e_match_types_enum, number>>
      >
    > = {};

    for (const region of regions.e_game_server_node_regions) {
      regionStats[region.value as e_game_server_node_regions_enum] = {
        Wingman: await this.getQueueLength(
          "Wingman",
          region.value as e_game_server_node_regions_enum,
        ),
        Competitive: await this.getQueueLength(
          "Competitive",
          region.value as e_game_server_node_regions_enum,
        ),
      };
    }

    if (user) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: user.steam_id,
          event: "match-making:region-stats",
          data: regionStats,
        }),
      );

      return;
    }

    await this.redis.publish(
      `broadcast-message`,
      JSON.stringify({
        event: "match-making:region-stats",
        data: regionStats,
      }),
    );
  }

  public async sendJoinedQueuedsToUser(steamId: string) {
    const queues = await this.redis.hgetall(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
    );

    await this.redis.publish(
      `send-message-to-steam-id`,
      JSON.stringify({
        steamId: steamId,
        event: "match-making:joined",
        data: await Promise.all(
          (queues.data ? JSON.parse(queues.data) : []).map(
            async (queue: {
              joinedAt: string;
              type: e_match_types_enum;
              region: e_game_server_node_regions_enum;
            }) => {
              const queueLength = await this.getQueueLength(
                queue.type,
                queue.region,
              );

              return {
                ...queue,
                currentPosition:
                  1 +
                  (await this.redis.zrank(
                    MatchMakingService.MATCH_MAKING_QUEUE_KEY(
                      queue.type,
                      queue.region,
                    ),
                    steamId,
                  )),
              };
            },
          ),
        ),
      }),
    );
  }

  public async sendJoinedQueuesToAllUsers(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
    const steamIds = await this.redis.zrange(
      MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
      0,
      -1,
    );

    for (const steamId of steamIds) {
      await this.sendJoinedQueuedsToUser(steamId);
    }
  }

  public async cancelMatchMaking(confirmationId: string) {
    const type = (await this.redis.hget(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "type",
    )) as e_match_types_enum;

    const region = (await this.redis.hget(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "region",
    )) as e_game_server_node_regions_enum;

    await this.redis.del(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    );

    const matchMakingQueueKey = MatchMakingService.MATCH_MAKING_QUEUE_KEY(
      type,
      region,
    );

    const players = JSON.parse(
      (await this.redis.hget(
        MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
        "players",
      )) || "[]",
    );

    // TODO - get zscore = joinedAt

    for (const player of players) {
      console.info("PLAYER", player);
    }
    // // TODO - since priority is the date, we need to handle it differently
    // for (const { steamId, priority } of players) {
    //   await this.redis.zadd(matchMakingQueueKey, priority, steamId);
    // }

    this.matchmake(type, region);
  }

  private async matchmake(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
    lock = true,
  ) {
    const matchMakingQueueKey = MatchMakingService.MATCH_MAKING_QUEUE_KEY(
      type,
      region,
    );

    if (lock) {
      const lockKey = `matchmaking-lock:${type}:${region}`;
      const acquireLock = !!(await this.redis.set(lockKey, 1, "NX"));

      if (!acquireLock) {
        return;
      }

      try {
        await this.matchmake(type, region);
      } finally {
        await this.redis.del(lockKey);
      }
    }

    const requiredPlayers = type === "Wingman" ? 4 : 10;

    const totalPlayersInQueue = await this.getQueueLength(type, region);

    if (totalPlayersInQueue < requiredPlayers) {
      return;
    }

    const steamIds = await this.redis.zrange(
      matchMakingQueueKey,
      0,
      requiredPlayers - 1,
    );

    await this.redis.zremrangebyrank(
      matchMakingQueueKey,
      0,
      requiredPlayers - 1,
    );

    const confirmationId = uuidv4();

    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      {
        region,
        type,
        steamIds,
      },
    );

    for (const steamId of steamIds) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId,
          event: "match-making:confirmation",
          data: {
            type,
            region,
            confirmationId,
            totalConfirmed: 0,
          },
        }),
      );
    }

    await this.matchmake(type, region, false);

    this.matchAssistant.cancelMatchMaking(confirmationId);
  }
}
