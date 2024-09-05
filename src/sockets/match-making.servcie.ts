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
    return `match-making:v22:${region}:${type}`;
  }

  protected static MATCH_MAKING_CONFIRMATION_KEY(confirmationId: string) {
    return `match-making:v22:${confirmationId}`;
  }

  protected static MATCH_MAKING_USER_QUEUE_KEY(steamId: string) {
    return `match-making:v22:user:${steamId}`;
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
      (await this.redis.hget(userQueueKey, "details")) || "[]",
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

    await this.redis.hset(
      userQueueKey,
      "details",
      JSON.stringify(existingQueues),
    );

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

    if (
      await this.redis.hget(
        MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
        `${user.steam_id}`,
      )
    ) {
      return;
    }

    await this.redis.hincrby(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "confirmed",
      1,
    );

    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      `${user.steam_id}`,
      1,
    );

    const { players, type, region, confirmed } =
      await this.getMatchConfirmationDetails(confirmationId);

    for (const steamId of players) {
      this.sendJoinedQueuedsToUser(steamId);
    }

    // TODO -  + 1 for testing
    if (confirmed != players.length + 1) {
      return;
    }

    await this.matchAssistant.removeCancelMatchMakingDueToReadyCheck(
      confirmationId,
    );

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

    const lineup1PlayersToInsert =
      type === "Wingman" ? players.slice(0, 2) : players.slice(0, 5);
    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: lineup1PlayersToInsert.map((steamId: string) => ({
            steam_id: steamId,
            match_lineup_id: match.lineup_1_id,
          })),
        },
        __typename: true,
      },
    });

    const lineup2PlayersToInsert =
      type === "Wingman" ? players.slice(2) : players.slice(5);
    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: lineup2PlayersToInsert.map((steamId: string) => ({
            steam_id: steamId,
            match_lineup_id: match.lineup_1_id,
          })),
        },
        __typename: true,
      },
    });

    await this.redis.set(`matches:confirmation:${match.id}`, confirmationId);

    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "matchId",
      match.id,
    );

    for (const steamId of players) {
      this.sendJoinedQueuedsToUser(steamId);
    }

    await this.matchAssistant.updateMatchStatus(match.id, "Veto");
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

    await this.redis.del(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(user.steam_id),
    );

    await this.sendRegionStats();
    await this.sendJoinedQueuedsToUser(user.steam_id);
    await this.sendJoinedQueuesToAllUsers(type, region);
  }

  public async getQueueLength(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
    return await this.redis.zcard(
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
    const { details, confirmationId } = await this.redis.hgetall(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
    );

    let confirmationDetails;
    if (confirmationId) {
      const { matchId, confirmed, type, region, players, expiresAt } =
        await this.getMatchConfirmationDetails(confirmationId);

      confirmationDetails = {
        type,
        region,
        matchId,
        expiresAt,
        confirmed,
        confirmationId,
        players: players.length,
        isReady: await this.redis.hget(
          MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
          `${steamId}`,
        ),
      };
    }

    await this.redis.publish(
      `send-message-to-steam-id`,
      JSON.stringify({
        steamId: steamId,
        event: "match-making:details",
        data: {
          confirmation: confirmationId && confirmationDetails,
          details: await Promise.all(
            (details ? JSON.parse(details) : []).map(
              async (queue: {
                joinedAt: string;
                type: e_match_types_enum;
                region: e_game_server_node_regions_enum;
              }) => {
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
        },
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

  public async cancelMatchMakingByMatchId(matchId: string) {
    const confirmationId = await this.redis.get(
      `matches:confirmation:${matchId}`,
    );

    if (confirmationId) {
      await this.cancelMatchMaking(confirmationId);
    }
  }

  public async cancelMatchMaking(
    confirmationId: string,
    readyCheckFailed: boolean = false,
  ) {
    console.info("CANCEL MATCH MAKING", confirmationId, readyCheckFailed);
    const { players, type, region } =
      await this.getMatchConfirmationDetails(confirmationId);

    for (const steamId of players) {
      if (readyCheckFailed) {
        const wasReady = await this.redis.hget(
          MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
          steamId,
        );

        if (wasReady) {
          await this.redis.hdel(
            MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
            "confirmationId",
          );

          // TODO - get the time they initially queu

          await this.redis.zadd(
            MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
            new Date().getTime(),
            steamId,
          );
          this.sendJoinedQueuedsToUser(steamId);
          continue;
        }
      }

      await this.redis.del(
        MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
      );

      this.sendJoinedQueuedsToUser(steamId);
    }

    await this.redis.del(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    );

    await this.sendRegionStats();

    if (!readyCheckFailed) {
      return;
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
        console.warn("unable to acquire lock");
        return;
      }

      try {
        await this.matchmake(type, region, false);
        return;
      } finally {
        await this.redis.del(lockKey);
      }
    }

    const requiredPlayers = type === "Wingman" ? 4 : 10;

    const totalPlayersInQueue = await this.getQueueLength(type, region);

    console.info("TOTLAL IN QUEUE", totalPlayersInQueue);

    if (totalPlayersInQueue === 0) {
      return;
    }

    // if (totalPlayersInQueue < requiredPlayers) {
    //   return;
    // }

    const confirmationId = uuidv4();

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

    const expiresAt = new Date();

    expiresAt.setSeconds(expiresAt.getSeconds() + 30);

    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      {
        type,
        region,
        expiresAt: expiresAt.toISOString(),
        steamIds: JSON.stringify(steamIds),
      },
    );

    for (const steamId of steamIds) {
      await this.redis.hset(
        MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
        "confirmationId",
        confirmationId,
      );

      this.sendJoinedQueuedsToUser(steamId);
    }

    await this.matchmake(type, region, false);

    this.matchAssistant.cancelMatchMakingDueToReadyCheck(confirmationId);
  }

  private async getMatchConfirmationDetails(confirmationId: string) {
    const { type, region, steamIds, confirmed, matchId, expiresAt } =
      await this.redis.hgetall(
        MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      );

    return {
      matchId,
      expiresAt,
      players: JSON.parse(steamIds || "[]"),
      confirmed: parseInt(confirmed || "0"),
      type: type as e_match_types_enum,
      region: region as e_game_server_node_regions_enum,
    };
  }
}
