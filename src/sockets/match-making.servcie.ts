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
    return `match-making:v12:${region}:${type}`;
  }

  protected static MATCH_MAKING_CONFIRMATION_KEY(matchId: string) {
    return `match-making:v12:${matchId}`;
  }

  protected static MATCH_MAKING_USER_QUEUE_KEY(steamId: string) {
    return `match-making:v12:user:${steamId}`;
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

    await this.redis.zadd(matchMakingQueueKey, 0, user.steam_id),
      await this.redis.sadd(
        MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(user.steam_id),
        JSON.stringify({ type, region }),
      );

    await this.sendJoinedQueuedsToUser(user);
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
    ),
      await this.redis.srem(
        MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(user.steam_id),
        JSON.stringify({ type, region }),
      );

    await this.sendRegionStats();
    await this.sendJoinedQueuedsToUser(user);
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

  public async sendJoinedQueuedsToUser(user: User) {
    const queues = await this.redis.smembers(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(user.steam_id),
    );

    await this.redis.publish(
      `send-message-to-steam-id`,
      JSON.stringify({
        steamId: user.steam_id,
        event: "match-making:joined",
        data: await Promise.all(
          queues.map(async (queue) => {
            const queueData = JSON.parse(queue);

            const queueLength = await this.getQueueLength(
              queueData.type,
              queueData.region,
            );

            const userRank = await this.redis.zrank(
              MatchMakingService.MATCH_MAKING_QUEUE_KEY(
                queueData.type,
                queueData.region,
              ),
              user.steam_id,
            );

            const currentPosition =
              userRank !== null ? queueLength - userRank : queueLength;

            return {
              ...queueData,
              currentPosition,
            };
          }),
        ),
      }),
    );
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

    const playersData = JSON.parse(
      (await this.redis.hget(
        MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
        "players",
      )) || "[]",
    );

    for (const { steamId, priority } of playersData) {
      await this.redis.zadd(matchMakingQueueKey, priority, steamId);
    }

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

    const potentialPlayers = await this.redis.zrange(
      matchMakingQueueKey,
      0,
      requiredPlayers - 1,
      "WITHSCORES",
    );

    await this.redis.zremrangebyrank(
      matchMakingQueueKey,
      0,
      requiredPlayers - 1,
    );

    const confirmationId = uuidv4();

    const players = JSON.stringify(
      potentialPlayers
        .filter((_, index) => index % 2 === 0)
        .map((steamId) => {
          return {
            steamId,
            priority: this.redis.zscore(matchMakingQueueKey, steamId),
          };
        }),
    );

    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      {
        region,
        type,
        players,
      },
    );

    for (let i = 0; i < potentialPlayers.length; i += 2) {
      const steamId = potentialPlayers[i];
      await this.askForConfirmation(steamId, confirmationId, type, region);
    }

    await this.matchmake(type, region, false);

    this.matchAssistant.cancelMatchMaking(confirmationId);
  }

  private async askForConfirmation(
    steamId: string,
    confirmationId: string,
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
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
}
