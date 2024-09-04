import { Injectable } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { e_game_server_node_regions_enum, e_match_types_enum } from "generated";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { v4 as uuidv4 } from "uuid";

@Injectable()
export class MatchMakingService {
  private redis: Redis;

  constructor(
    private readonly redisManager: RedisManagerService,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  protected static MATCH_MAKING_QUEUE_KEY(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
    return `match-making:${region}:${type}`;
  }

  protected static MATCH_MAKING_CONFIRMATION_KEY(matchId: string) {
    return `match-making:${matchId}`;
  }

  public async getQueueLength(
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
    const matchMakingQueueKey = MatchMakingService.MATCH_MAKING_QUEUE_KEY(
      type,
      region,
    );

    return this.redis.zcard(matchMakingQueueKey);
  }

  public async joinMatchMaking(
    user: User,
    type: e_match_types_enum,
    region: e_game_server_node_regions_enum,
  ) {
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

    await this.redis.zadd(matchMakingQueueKey, 0, user.steam_id);

    this.matchmake(type, region);
  }

  public async confirmMatch(user: User, confirmationId: string) {
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

  public async cancelMatchMaking(confirmationId: string) {
    const players = await this.redis.hkeys(
      MatchMakingService.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    );
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
