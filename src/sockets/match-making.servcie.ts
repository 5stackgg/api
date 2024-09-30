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
import { Logger } from "@nestjs/common";

@WebSocketGateway({
  path: "/ws",
})
export class MatchMakingService {
  private redis: Redis;

  constructor(
    private readonly logger: Logger,
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
    return `match-making:v29:${region}:${type}`;
  }

  protected static MATCH_MAKING_CONFIRMATION_KEY(confirmationId: string) {
    return `match-making:v29:${confirmationId}`;
  }

  protected static MATCH_MAKING_USER_QUEUE_KEY(steamId: string) {
    return `match-making:v29:user:${steamId}`;
  }

  @SubscribeMessage("match-making:join-queue")
  async joinQueue(
    @MessageBody()
    data: {
      type: e_match_types_enum;
      regions: Array<e_game_server_node_regions_enum>;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const { type, regions } = data;

    if (!type || !regions || regions.length === 0) {
      return;
    }

    const user = client.user;

    const existingUserInQueue = await this.getUserQueueDetails(user.steam_id);

    if (existingUserInQueue) {
      this.logger.warn(`user ${user.steam_id} already in queue`);
      return;
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: user.steam_id,
        },
        matchmaking_cooldown: true,
      },
    });

    if (players_by_pk.matchmaking_cooldown) {
      return;
    }

    const joinedAt = new Date();

    /**
     * setup the user queue details
     */
    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(user.steam_id),
      "details",
      JSON.stringify({ type, regions, joinedAt: joinedAt.toISOString() }),
    );

    /**
     * for each region add player into the queue
     */
    for (const region of regions) {
      // TODO - and speicic maps or map pool id
      await this.redis.zadd(
        MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
        joinedAt.getTime(),
        user.steam_id,
      );
    }

    await this.sendQueueDetailsToUser(user.steam_id);
    await this.sendRegionStats();

    for (const region of regions) {
      this.matchmake(type, region);
    }
  }

  private async getUserQueueDetails(steamId: string) {
    const data = await this.redis.hget(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
      "details",
    );

    if (!data) {
      return;
    }

    const details = JSON.parse(data);

    details.regionPositions = {};

    for (const region of details.regions) {
      const position = await this.redis.zrank(
        MatchMakingService.MATCH_MAKING_QUEUE_KEY(details.type, region),
        steamId,
      );

      details.regionPositions[region] = position + 1;
    }

    return details;
  }

  private async removeUserFromQueue(steamId: string) {
    await this.removeUserFromRegions(steamId);

    /**
     * remove the user queue details
     */
    await this.redis.del(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
    );
  }

  private async removeUserFromRegions(steamId: string) {
    const userQueueDetails = await this.getUserQueueDetails(steamId);

    if (!userQueueDetails) {
      return;
    }

    const type = userQueueDetails.type;

    /**
     * remove player from each region they queued for
     */
    for (const region of userQueueDetails.regions) {
      await this.redis.zrem(
        MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
        steamId,
      );
    }
  }

  @SubscribeMessage("match-making:leave")
  async leaveQueue(@ConnectedSocket() client: FiveStackWebSocketClient) {
    const user = client.user;

    const userQueueDetails = await this.getUserQueueDetails(user.steam_id);

    const type = userQueueDetails.type;

    await this.removeUserFromQueue(user.steam_id);

    await this.sendRegionStats();
    await this.sendQueueDetailsToUser(user.steam_id);

    for (const region of userQueueDetails.regions) {
      await this.sendQueueDetailsToAllUsers(type, region);
    }
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

    /**
     * if the user has already confirmed, do nothing
     */
    if (
      await this.redis.hget(
        MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
        `${user.steam_id}`,
      )
    ) {
      return;
    }

    /**
     * increment the number of players that have confirmed
     */
    await this.redis.hincrby(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "confirmed",
      1,
    );

    /**
     * set the user as confirmed
     */
    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      `${user.steam_id}`,
      1,
    );

    const { players, type, region, confirmed } =
      await this.getMatchConfirmationDetails(confirmationId);

    for (const steamId of players) {
      this.sendQueueDetailsToUser(steamId);
    }

    if (confirmed != players.length) {
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
        best_of: 1,
        knife: true,
        overtime: true,
        timeout_setting: "Admin",
        region: region as e_game_server_node_regions_enum,
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
            match_lineup_id: match.lineup_2_id,
          })),
        },
        __typename: true,
      },
    });

    /**
     * after the match is finished we need to remove people form the queue so they can queue again
     */
    await this.redis.set(`matches:confirmation:${match.id}`, confirmationId);

    /**
     * add match id to the confirmation details
     */
    await this.redis.hset(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      "matchId",
      match.id,
    );

    for (const steamId of players) {
      this.sendQueueDetailsToUser(steamId);
    }

    await this.matchAssistant.updateMatchStatus(match.id, "Veto");
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
            _and: [
              {
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
            ],
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

  public async sendQueueDetailsToUser(steamId: string) {
    let confirmationDetails;
    const confirmationId = await this.redis.hget(
      MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
      "confirmationId",
    );

    if (confirmationId) {
      const { matchId, confirmed, type, region, players, expiresAt } =
        await this.getMatchConfirmationDetails(confirmationId);

      const isReady = await this.redis.hget(
        MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
        steamId,
      );

      confirmationDetails = {
        type,
        region,
        matchId,
        expiresAt,
        confirmed,
        confirmationId,
        isReady: !!isReady,
        players: players.length,
      };
    }

    await this.redis.publish(
      `send-message-to-steam-id`,
      JSON.stringify({
        steamId: steamId,
        event: "match-making:details",
        data: {
          details: await this.getUserQueueDetails(steamId),
          confirmation: confirmationId && confirmationDetails,
        },
      }),
    );
  }

  public async sendQueueDetailsToAllUsers(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
    const steamIds = await this.redis.zrange(
      MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
      0,
      -1,
    );

    for (const steamId of steamIds) {
      await this.sendQueueDetailsToUser(steamId);
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
    const { players, type, region } =
      await this.getMatchConfirmationDetails(confirmationId);

    for (const steamId of players) {
      if (readyCheckFailed) {
        const wasReady = await this.redis.hget(
          MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
          steamId,
        );

        if (wasReady) {
          /**
           * if they wre ready, we want to requeue them into the queue
           */
          await this.redis.hdel(
            MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
            "confirmationId",
          );

          const { regions, joinedAt } = await this.getUserQueueDetails(steamId);
          for (const region of regions) {
            await this.redis.zadd(
              MatchMakingService.MATCH_MAKING_QUEUE_KEY(type, region),
              new Date(joinedAt).getTime(),
              steamId,
            );
          }

          this.sendQueueDetailsToUser(steamId);
          continue;
        }
      }

      await this.removeUserFromQueue(steamId);

      this.sendQueueDetailsToUser(steamId);
    }

    /**
     * remove the confirmation details
     */
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
    if (lock) {
      const lockKey = `matchmaking-lock:${type}:${region}`;
      const acquireLock = !!(await this.redis.set(lockKey, 1, "NX"));

      if (!acquireLock) {
        this.logger.warn("unable to acquire lock");
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

    if (totalPlayersInQueue === 0) {
      return;
    }

    if (totalPlayersInQueue < requiredPlayers) {
      return;
    }

    const confirmationId = uuidv4();

    const matchMakingQueueKey = MatchMakingService.MATCH_MAKING_QUEUE_KEY(
      type,
      region,
    );

    const result = await this.redis.zpopmin(
      matchMakingQueueKey,
      requiredPlayers,
    );

    const steamIds = result.filter((_, index) => index % 2 === 0);

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

    /**
     * assign the confirmation id to the players
     */
    for (const steamId of steamIds) {
      await this.redis.hset(
        MatchMakingService.MATCH_MAKING_USER_QUEUE_KEY(steamId),
        "confirmationId",
        confirmationId,
      );

      this.sendQueueDetailsToUser(steamId);
    }

    /**
     * if the total number of players in the queue is still greater than the required number of players,
     */
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
