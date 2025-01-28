import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { e_match_types_enum } from "generated";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { v4 as uuidv4, validate as validateUUID } from "uuid";
import { HasuraService } from "src/hasura/hasura.service";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";

interface TeamCombination {
  lobbies: string[];
  players: string[];
  avgRank: number;
}

type VerifyPlayerStatus = {
  steam_id: string;
  is_banned: boolean;
  matchmaking_cooldown: boolean;
};

@WebSocketGateway({
  path: "/ws/web",
})
export class MatchmakingGateway {
  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  // TODO - make a SET for each player that bleongs to a lobby

  protected static MATCH_MAKING_QUEUE_KEY(
    type: e_match_types_enum,
    region: string,
  ) {
    return `matchmaking:v1:${region}:${type}`;
  }

  protected static MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId: string) {
    return `matchmaking:v1:details:${lobbyId}`;
  }

  protected static MATCH_MAKING_CONFIRMATION_KEY(confirmationId: string) {
    return `matchmaking:v1:${confirmationId}`;
  }

  protected static MATCH_MAKING_RANK_KEY(
    type: e_match_types_enum,
    region: string,
  ) {
    return `matchmaking:v1:${region}:${type}:ranks`;
  }

  // TODO - send reason why they cant join the queue
  @SubscribeMessage("matchmaking:join-queue")
  async joinQueue(
    @MessageBody()
    data: {
      type: e_match_types_enum;
      regions: Array<string>;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await this.leaveQueue(client);

    const user = client.user;

    if (!user) {
      return;
    }

    const { type, regions } = data;

    if (!type || !regions || regions.length === 0) {
      return;
    }

    const lobby = await this.getPlayerLobby(user);

    if (!lobby) {
      return;
    }

    const joinedAt = new Date();

    await this.setQueuedDetails(lobby.id, {
      type,
      regions,
      joinedAt,
      lobbyId: lobby.id,
      players: lobby.players.map(({ steam_id }) => steam_id),
    });

    const avgRank = await this.getAverageLobbyRank(lobby.id);

    // Store the lobby's rank in a separate sorted set for quick rank matching
    for (const region of regions) {
      await this.redis.zadd(
        MatchmakingGateway.MATCH_MAKING_RANK_KEY(type, region),
        avgRank,
        lobby.id,
      );
    }

    /**
     * for each region add lobby into the queue
     */
    for (const region of regions) {
      // TODO - and speicic maps or map pool id
      await this.redis.zadd(
        MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
        joinedAt.getTime(),
        lobby.id,
      );
    }

    await this.sendQueueDetailsToLobby(lobby.id);
    await this.sendRegionStats();

    for (const region of regions) {
      this.matchmake(type, region);
    }
  }

  private async setQueuedDetails(
    lobbyId: string,
    details: {
      lobbyId: string;
      type: e_match_types_enum;
      regions: Array<string>;
      joinedAt: Date;
      players: Array<string>;
    },
  ) {
    await this.redis.hset(
      MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId),
      "details",
      JSON.stringify(details),
    );
  }

  private async getLobbyDetails(lobbyId: string) {
    const data = await this.redis.hget(
      MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId),
      "details",
    );

    if (!data) {
      return;
    }

    const details = JSON.parse(data);

    details.regionPositions = {};

    for (const region of details.regions) {
      const position = await this.redis.zrank(
        MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(details.type, region),
        lobbyId,
      );

      details.regionPositions[region] = position + 1;
    }

    return details;
  }

  private async removeLobbyFromQueue(lobbyId: string) {
    const queueDetails = await this.getLobbyDetails(lobbyId);
    if (!queueDetails) {
      return
    };

    // Use pipeline for multiple Redis operations
    const pipeline = this.redis.pipeline();

    for (const region of queueDetails.regions) {
      pipeline.zrem(
        MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(queueDetails.type, region),
        lobbyId,
      );
      pipeline.zrem(
        MatchmakingGateway.MATCH_MAKING_RANK_KEY(queueDetails.type, region),
        lobbyId,
      );
    }

    pipeline.del(MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId));

    // Notify players
    for (const player of queueDetails.players) {
      pipeline.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: player,
          event: "matchmaking:details",
          data: {},
        }),
      );
    }

    await pipeline.exec();
    await this.sendRegionStats();
  }

  @SubscribeMessage("matchmaking:leave")
  async leaveQueue(@ConnectedSocket() client: FiveStackWebSocketClient) {
    const user = client.user;

    if (!user) {
      return;
    }

    const lobby = await this.getPlayerLobby(user);

    if (!lobby) {
      return;
    }

    await this.removeLobbyFromQueue(lobby.id);
  }

  // TODO
  @SubscribeMessage("matchmaking:confirm")
  async playerConfirmation(
    @MessageBody()
    data: {
      confirmationId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    // const user = client.user;
    // if (!user) {
    //   return;
    // }
    // const { confirmationId } = data;
    // /**
    //  * if the user has already confirmed, do nothing
    //  */
    // if (
    //   await this.redis.hget(
    //     MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //     `${user.steam_id}`,
    //   )
    // ) {
    //   return;
    // }
    // /**
    //  * increment the number of players that have confirmed
    //  */
    // await this.redis.hincrby(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //   "confirmed",
    //   1,
    // );
    // /**
    //  * set the user as confirmed
    //  */
    // await this.redis.hset(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //   `${user.steam_id}`,
    //   1,
    // );
    // const { players, type, region, confirmed } =
    //   await this.getMatchConfirmationDetails(confirmationId);
    //   for(const player of players) {
    //     // this.sendQueueDetailsToLobby(player);
    //   }
    // if (confirmed != players.length) {
    //   return;
    // }
    // const match = await this.matchAssistant.createMatchBasedOnType(
    //   type as e_match_types_enum,
    //   // TODO - get map pool by type
    //   "Competitive",
    //   {
    //     mr: 12,
    //     best_of: 1,
    //     knife: true,
    //     overtime: true,
    //     timeout_setting: "Admin",
    //     region,
    //   },
    // );
    // await this.matchAssistant.removeCancelMatchMakingDueToReadyCheck(
    //   confirmationId,
    // );
    // const lineup1PlayersToInsert =
    //   type === "Wingman" ? players.slice(0, 2) : players.slice(0, 5);
    // await this.hasura.mutation({
    //   insert_match_lineup_players: {
    //     __args: {
    //       objects: lineup1PlayersToInsert.map((steamId: string) => ({
    //         steam_id: steamId,
    //         match_lineup_id: match.lineup_1_id,
    //       })),
    //     },
    //     __typename: true,
    //   },
    // });
    // const lineup2PlayersToInsert =
    //   type === "Wingman" ? players.slice(2) : players.slice(5);
    // await this.hasura.mutation({
    //   insert_match_lineup_players: {
    //     __args: {
    //       objects: lineup2PlayersToInsert.map((steamId: string) => ({
    //         steam_id: steamId,
    //         match_lineup_id: match.lineup_2_id,
    //       })),
    //     },
    //     __typename: true,
    //   },
    // });
    // /**
    //  * after the match is finished we need to remove people form the queue so they can queue again
    //  */
    // await this.redis.set(`matches:confirmation:${match.id}`, confirmationId);
    // /**
    //  * add match id to the confirmation details
    //  */
    // await this.redis.hset(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //   "matchId",
    //   match.id,
    // );
    // for (const steamId of players) {
    //   // this.sendQueueDetailsToLobby(lobbyId, steamId);
    // }
    // await this.matchAssistant.updateMatchStatus(match.id, "Veto");
  }

  public async getNumberOfPlayersInQueue(
    type: e_match_types_enum,
    region: string,
  ) {
    return await this.redis.zcard(
      MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
    );
  }

  public async sendRegionStats(user?: User) {
    const regions = await this.hasura.query({
      server_regions: {
        __args: {
          where: {
            _and: [
              {
                total_server_count: {
                  _gt: 0,
                },
                is_lan: {
                  _eq: false,
                },
              },
            ],
          },
        },
        value: true,
      },
    });

    const regionStats: Partial<
      Record<string, Partial<Record<e_match_types_enum, number>>>
    > = {};

    for (const region of regions.server_regions) {
      regionStats[region.value] = {
        Wingman: await this.getNumberOfPlayersInQueue("Wingman", region.value),
        Competitive: await this.getNumberOfPlayersInQueue(
          "Competitive",
          region.value,
        ),
      };
    }

    if (user) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: user.steam_id,
          event: "matchmaking:region-stats",
          data: regionStats,
        }),
      );

      return;
    }

    await this.redis.publish(
      `broadcast-message`,
      JSON.stringify({
        event: "matchmaking:region-stats",
        data: regionStats,
      }),
    );
  }

  // TODO - extermly inefficient
  public async sendQueueDetailsToPlayer(user: User) {
    const lobby = await this.getPlayerLobby(user);

    if (!lobby) {
      return;
    }

    await this.sendQueueDetailsToLobby(lobby.id);
  }

  public async sendQueueDetailsToLobby(lobbyId: string) {
    let confirmationDetails;
    const confirmationId = await this.redis.hget(
      MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId),
      "confirmationId",
    );

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
      };
    }

    const lobbyQueueDetails = await this.getLobbyDetails(lobbyId);
    if (!lobbyQueueDetails) {
      console.warn(`Lobby ${lobbyId} not found in queue`);
      return;
    }

    for (const player of lobbyQueueDetails.players) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: player,
          event: "matchmaking:details",
          data: {
            details: await this.getLobbyDetails(lobbyId),
            confirmation: confirmationId && {
              ...confirmationDetails,
              isReady:
                confirmationId &&
                (await this.redis.hget(
                  MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(
                    confirmationId,
                  ),
                  player,
                )),
            },
          },
        }),
      );
    }
  }

  public async sendQueueDetailsToAllUsers(
    type: e_match_types_enum,
    region: string,
  ) {
    const lobbies = await this.redis.zrange(
      MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
      0,
      -1,
    );

    for (const lobbyId of lobbies) {
      await this.sendQueueDetailsToLobby(lobbyId);
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

  // TODO
  public async cancelMatchMaking(
    confirmationId: string,
    readyCheckFailed: boolean = false,
  ) {
    console.info("CANCEL MATCH MAKING REODO");
    // const { players, type, region } =
    //   await this.getMatchConfirmationDetails(confirmationId);

    // for (const steamId of players) {
    //   if (readyCheckFailed) {
    //     const wasReady = await this.redis.hget(
    //       MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //       steamId,
    //     );

    //     if (wasReady) {
    //       /**
    //        * if they wre ready, we want to requeue them into the queue
    //        */
    //       // I thin this was to remove the confirmation ID from the match?
    //       // await this.redis.hdel(
    //       //   MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(steamId),
    //       //   "confirmationId",
    //       // );

    //       const { regions, joinedAt } = await this.getLobbyDetails(steamId);
    //       for (const region of regions) {
    //         // TODO - re-add them to the queue
    //         // await this.redis.zadd(
    //         //   MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
    //         //   new Date(joinedAt).getTime(),
    //         //   steamId,
    //         // );
    //       }

    //       this.sendQueueDetailsToLobby(steamId);
    //       continue;
    //     }
    //   }

    //   await this.removeLobbyFromQueue(steamId);

    //   this.sendQueueDetailsToLobby(steamId);
    // }

    // /**
    //  * remove the confirmation details
    //  */
    // await this.redis.del(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    // );

    // await this.sendRegionStats();

    // if (!readyCheckFailed) {
    //   return;
    // }

    // this.matchmake(type, region);
  }

  private async matchmake(
    type: e_match_types_enum,
    region: string,
    lock = true,
  ) {
    const queueKey = MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region);
    const rankKey = MatchmakingGateway.MATCH_MAKING_RANK_KEY(type, region);

    // Check queue size first
    const queueSize = await this.redis.zcard(queueKey);
    const requiredPlayers = type === "Wingman" ? 4 : 10;
    const playersPerTeam = requiredPlayers / 2;

    if (queueSize < 2) {
      return;
    }

    // Different strategies based on queue size
    if (queueSize > 1000) {
      await this.parallelMatchmaking(type, region, playersPerTeam);
    } else {
      // Use original matchmaking for smaller queues
      if (lock) {
        const lockKey = `matchmaking-lock:${type}:${region}`;
        const lockValue = Date.now().toString();
        const acquireLock = !!(await this.redis.set(
          lockKey,
          lockValue,
          "EX",
          10,
          "NX",
        ));

        if (!acquireLock) {
          this.logger.warn("Unable to acquire lock");
          return;
        }

        try {
          await this.matchmake(type, region, false);
        } finally {
          await this.redis.eval(
            `
            if redis.call("get",KEYS[1]) == ARGV[1]
            then
                return redis.call("del",KEYS[1])
            else
                return 0
            end
          `,
            1,
            lockKey,
            lockValue,
          );
        }
        return;
      }

      // Original matchmaking logic for smaller queues
      // Get oldest lobby first to determine rank range
      const oldestLobby = (await this.redis.eval(
        `
        local queueKey = KEYS[1]
        local rankKey = KEYS[2]
        
        local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
        if #oldest == 0 then
          return nil
        end
        
        local lobbyId = oldest[1]
        local joinTime = oldest[2]
        local rank = redis.call('ZSCORE', rankKey, lobbyId)
        
        return {lobbyId, joinTime, rank}
      `,
        2,
        queueKey,
        rankKey,
      )) as [string, string, string] | null;

      if (!oldestLobby) {
        this.logger.debug("No lobbies in queue");
        return;
      }

      const [oldestLobbyId, joinTime, rankStr] = oldestLobby;
      const oldestLobbyDetails = await this.getLobbyDetails(oldestLobbyId);

      if (!oldestLobbyDetails) {
        this.logger.warn(`Invalid oldest lobby found: ${oldestLobbyId}`);
        await this.removeLobbyFromQueue(oldestLobbyId);
        return;
      }

      const baseRank = parseFloat(rankStr);
      const waitTimePriority = Math.floor(
        (Date.now() - parseInt(joinTime)) / 10000,
      );
      const rankRange = Math.min(50 + waitTimePriority * 10, 500);

      // Get lobbies within rank range
      const lobbiesInRange = (await this.redis.eval(
        `
        local rankKey = KEYS[1]
        local queueKey = KEYS[2]
        local baseRank = tonumber(ARGV[1])
        local rankRange = tonumber(ARGV[2])
        local maxLobbies = tonumber(ARGV[3])
        
        local minRank = baseRank - rankRange
        local maxRank = baseRank + rankRange
        
        -- Get lobbies within rank range, ordered by join time
        local lobbies = redis.call('ZRANGEBYSCORE', rankKey, minRank, maxRank, 'WITHSCORES')
        local result = {}
        local count = 0
        
        for i = 1, #lobbies, 2 do
          if count >= maxLobbies then
            break
          end
          
          local lobbyId = lobbies[i]
          local rank = tonumber(lobbies[i + 1])
          local joinTime = redis.call('ZSCORE', queueKey, lobbyId)
          
          if joinTime then
            table.insert(result, lobbyId)
            table.insert(result, joinTime)
            table.insert(result, rank)
            count = count + 1
          end
        end
        
        return result
      `,
        2,
        rankKey,
        queueKey,
        baseRank,
        rankRange,
        50,
      )) as string[];

      // Convert to structured data
      const lobbyDetails: Array<{
        id: string;
        players: string[];
        avgRank: number;
        joinTime: number;
      }> = [];

      for (let i = 0; i < lobbiesInRange.length; i += 3) {
        const details = await this.getLobbyDetails(lobbiesInRange[i]);
        if (details) {
          lobbyDetails.push({
            id: lobbiesInRange[i],
            players: details.players,
            avgRank: parseFloat(lobbiesInRange[i + 2]),
            joinTime: parseInt(lobbiesInRange[i + 1]),
          });
        }
      }

      // Sort by join time (oldest first)
      lobbyDetails.sort((a, b) => a.joinTime - b.joinTime);

      this.logger.debug(
        `Found ${lobbyDetails.length} lobbies within rank range ${baseRank}±${rankRange}`,
      );

      // Try to find valid team combinations
      const match = await this.findValidTeams(
        lobbyDetails[0], // Start with oldest lobby
        lobbyDetails,
        playersPerTeam,
        rankRange,
      );

      if (match) {
        const { team1, team2 } = match;
        this.logger.debug(
          `Found match! Team1: ${team1.lobbies.join(",")} vs Team2: ${team2.lobbies.join(",")}`,
        );

        // Create the match
        const allPlayers = [...team1.players, ...team2.players];
        await this.confirmMatchMaking(type, region, allPlayers);

        // Cleanup all matched lobbies
        const allLobbies = [...team1.lobbies, ...team2.lobbies];
        const cleanupPipeline = this.redis.pipeline();

        cleanupPipeline.zrem(queueKey, ...allLobbies);
        cleanupPipeline.zrem(rankKey, ...allLobbies);

        for (const lobbyId of allLobbies) {
          cleanupPipeline.del(
            MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId),
          );
        }

        await cleanupPipeline.exec();
        return;
      }

      this.logger.debug("No suitable match found in this iteration");
    }
  }

  private async parallelMatchmaking(
    type: e_match_types_enum,
    region: string,
    playersPerTeam: number,
  ) {
    const queueKey = MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region);
    const rankKey = MatchmakingGateway.MATCH_MAKING_RANK_KEY(type, region);
    const batchSize = 50; // Number of lobbies to process in each parallel batch

    // Get total number of lobbies to process
    const totalLobbies = await this.redis.zcard(queueKey);
    const numberOfBatches = Math.ceil(totalLobbies / batchSize);

    this.logger.debug(
      `Starting parallel matchmaking with ${numberOfBatches} batches`,
    );

    // Process multiple starting points in parallel
    const matchPromises = [];

    for (let i = 0; i < numberOfBatches; i++) {
      matchPromises.push(
        this.processMatchmakingBatch(
          type,
          region,
          i * batchSize,
          batchSize,
          playersPerTeam,
        ),
      );
    }

    // Wait for all batches to complete and collect results
    const batchResults = await Promise.all(matchPromises);

    // Process valid matches found
    for (const match of batchResults.filter(Boolean)) {
      const { team1, team2 } = match;

      // Try to acquire match lock
      const matchLockKey = `match-lock:${team1.lobbies.join(",")}:${team2.lobbies.join(",")}`;
      const lockAcquired = await this.redis.set(
        matchLockKey,
        "1",
        "EX",
        5,
        "NX",
      );

      if (!lockAcquired) {
        continue; // Another process already handling this match
      }

      try {
        // Verify all lobbies are still available
        const lobbiesExist = await this.verifyLobbiesStillAvailable(
          [...team1.lobbies, ...team2.lobbies],
          queueKey,
        );

        if (!lobbiesExist) {
          continue; // Some lobbies no longer available
        }

        // Create the match
        const allPlayers = [...team1.players, ...team2.players];
        await this.confirmMatchMaking(type, region, allPlayers);

        // Remove matched lobbies atomically
        const cleanupSuccess = await this.redis.eval(
          `
          local queueKey = KEYS[1]
          local rankKey = KEYS[2]
          local lobbies = cjson.decode(ARGV[1])
          
          -- Check all lobbies still exist
          for _, lobbyId in ipairs(lobbies) do
            if redis.call('ZSCORE', queueKey, lobbyId) == false then
              return false
            end
          end
          
          -- Remove from both sets
          for _, lobbyId in ipairs(lobbies) do
            redis.call('ZREM', queueKey, lobbyId)
            redis.call('ZREM', rankKey, lobbyId)
            redis.call('DEL', 'matchmaking:v1:details:' .. lobbyId)
          end
          
          return true
        `,
          2,
          queueKey,
          rankKey,
          JSON.stringify([...team1.lobbies, ...team2.lobbies]),
        );

        if (cleanupSuccess) {
          this.logger.debug(
            `Successfully matched teams: ${team1.lobbies.join(",")} vs ${team2.lobbies.join(",")}`,
          );
          break; // Successfully processed one match, exit loop
        }
      } finally {
        await this.redis.del(matchLockKey);
      }
    }
  }

  private async processMatchmakingBatch(
    type: e_match_types_enum,
    region: string,
    start: number,
    batchSize: number,
    playersPerTeam: number,
  ) {
    const queueKey = MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region);
    const rankKey = MatchmakingGateway.MATCH_MAKING_RANK_KEY(type, region);

    // Get batch of lobbies
    const lobbiesInBatch = (await this.redis.eval(
      `
      local queueKey = KEYS[1]
      local rankKey = KEYS[2]
      local start = tonumber(ARGV[1])
      local batchSize = tonumber(ARGV[2])
      
      local lobbies = redis.call('ZRANGE', queueKey, start, start + batchSize - 1, 'WITHSCORES')
      local result = {}
      
      for i = 1, #lobbies, 2 do
        local lobbyId = lobbies[i]
        local joinTime = lobbies[i + 1]
        local rank = redis.call('ZSCORE', rankKey, lobbyId)
        
        if rank then
          table.insert(result, lobbyId)
          table.insert(result, joinTime)
          table.insert(result, rank)
        end
      end
      
      return result
    `,
      2,
      queueKey,
      rankKey,
      start,
      batchSize,
    )) as string[];

    // Process batch similar to original logic
    const lobbyDetails = await this.processLobbyDetails(lobbiesInBatch);

    if (lobbyDetails.length < 2) return null;

    // Find valid teams within this batch
    const waitTimePriority = Math.floor(
      (Date.now() - lobbyDetails[0].joinTime) / 10000,
    );
    const rankRange = Math.min(50 + waitTimePriority * 10, 500);

    return this.findValidTeams(
      lobbyDetails[0],
      lobbyDetails,
      playersPerTeam,
      rankRange,
    );
  }

  private async verifyLobbiesStillAvailable(
    lobbyIds: string[],
    queueKey: string,
  ): Promise<boolean> {
    const pipeline = this.redis.pipeline();
    for (const lobbyId of lobbyIds) {
      pipeline.zscore(queueKey, lobbyId);
    }
    const results = await pipeline.exec();
    return results.every(([err, score]) => !err && score !== null);
  }

  private async processLobbyDetails(lobbiesData: string[]) {
    const lobbyDetails = [];

    for (let i = 0; i < lobbiesData.length; i += 3) {
      const details = await this.getLobbyDetails(lobbiesData[i]);
      if (details) {
        lobbyDetails.push({
          id: lobbiesData[i],
          players: details.players,
          avgRank: parseFloat(lobbiesData[i + 2]),
          joinTime: parseInt(lobbiesData[i + 1]),
        });
      }
    }

    return lobbyDetails;
  }

  private async findValidTeams(
    startingLobby: { id: string; players: string[]; avgRank: number },
    allLobbies: Array<{ id: string; players: string[]; avgRank: number }>,
    playersPerTeam: number,
    rankRange: number,
  ): Promise<{ team1: TeamCombination; team2: TeamCombination } | null> {
    this.logger.debug(
      `Finding valid teams starting with lobby ${startingLobby.id}`,
    );

    // Find all possible team combinations
    const team1Combinations = this.findTeamCombinations(
      startingLobby,
      allLobbies,
      playersPerTeam,
      new Set(),
    );

    if (team1Combinations.length === 0) {
      this.logger.debug("No valid team1 combinations found");
      return null;
    }

    for (const team1 of team1Combinations) {
      // Create set of used lobby IDs
      const usedLobbies = new Set(team1.lobbies);

      // Get remaining lobbies that aren't used in team1
      const remainingLobbies = allLobbies.filter((l) => !usedLobbies.has(l.id));

      if (remainingLobbies.length === 0) {
        this.logger.debug("No remaining lobbies for team2");
        continue;
      }

      // Try each remaining lobby as a starting point for team2
      for (const potentialTeam2Start of remainingLobbies) {
        const team2Combinations = this.findTeamCombinations(
          potentialTeam2Start,
          remainingLobbies,
          playersPerTeam,
          usedLobbies,
        );

        // Find best matching team2 within rank range
        const validTeam2 = team2Combinations.find(
          (team2) => Math.abs(team1.avgRank - team2.avgRank) <= rankRange,
        );

        if (validTeam2) {
          this.logger.debug(
            `Found valid match: Team1 (${team1.lobbies.join(",")}) vs Team2 (${validTeam2.lobbies.join(",")})`,
          );
          return { team1, team2: validTeam2 };
        }
      }
    }

    this.logger.debug("No valid team combinations found");
    return null;
  }

  private findTeamCombinations(
    startingLobby: { id: string; players: string[]; avgRank: number },
    allLobbies: Array<{ id: string; players: string[]; avgRank: number }>,
    targetSize: number,
    usedLobbies: Set<string>,
  ): TeamCombination[] {
    const combinations: TeamCombination[] = [];

    const findCombos = (
      current: TeamCombination,
      remainingLobbies: Array<{
        id: string;
        players: string[];
        avgRank: number;
      }>,
    ) => {
      if (current.players.length === targetSize) {
        combinations.push(current);
        return;
      }

      for (const lobby of remainingLobbies) {
        if (usedLobbies.has(lobby.id)) continue;

        const newPlayerCount = current.players.length + lobby.players.length;
        if (newPlayerCount > targetSize) continue;

        const newTotalRank =
          current.avgRank * current.players.length +
          lobby.avgRank * lobby.players.length;

        findCombos(
          {
            lobbies: [...current.lobbies, lobby.id],
            players: [...current.players, ...lobby.players],
            avgRank: newTotalRank / newPlayerCount,
          },
          remainingLobbies.filter((l) => l.id !== lobby.id),
        );
      }
    };

    findCombos(
      {
        lobbies: [startingLobby.id],
        players: startingLobby.players,
        avgRank: startingLobby.avgRank,
      },
      allLobbies.filter((l) => l.id !== startingLobby.id),
    );

    return combinations;
  }

  private async confirmMatchMaking(
    type: e_match_types_enum,
    region: string,
    players: Array<string>,
  ) {
    // const expiresAt = new Date();
    // expiresAt.setSeconds(expiresAt.getSeconds() + 30);
    // const confirmationId = uuidv4();
    // await this.redis.hset(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //   {
    //     type,
    //     region,
    //     expiresAt: expiresAt.toISOString(),
    //     steamIds: JSON.stringify(steamIds),
    //   },
    // );
    // /**
    //  * assign the confirmation id to the players
    //  */
    // for (const steamId of steamIds) {
    //   await this.redis.hset(
    //     MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(steamId),
    //     "confirmationId",
    //     confirmationId,
    //   );
    //   this.sendQueueDetailsToLobby(steamId);
    // }
    // /**
    //  * if the total number of players in the queue is still greater than the required number of players,
    //  */
    // await this.matchmake(type, region, false);
    // this.matchAssistant.cancelMatchMakingDueToReadyCheck(confirmationId);
  }

  private async getMatchConfirmationDetails(confirmationId: string) {
    const { type, region, steamIds, confirmed, matchId, expiresAt } =
      await this.redis.hgetall(
        MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
      );

    return {
      matchId,
      expiresAt,
      players: JSON.parse(steamIds || "[]"),
      confirmed: parseInt(confirmed || "0"),
      type: type as e_match_types_enum,
      region,
    };
  }

  // TODO - seperate to get lobby in one and another to verify isntead of doing in 1 step
  private async getPlayerLobby(user: User): Promise<{
    id: string;
    players: Array<{
      steam_id: string;
    }>;
  }> {
    let lobbyId = await this.getCurrentLobbyId(user.steam_id);

    let lobby;
    if (validateUUID(lobbyId)) {
      const { lobbies_by_pk } = await this.hasura.query({
        lobbies_by_pk: {
          __args: {
            id: lobbyId,
          },
          players: {
            __args: {
              where: {
                status: {
                  _eq: "Accepted",
                },
              },
            },
            steam_id: true,
            captain: true,
            player: {
              steam_id: true,
              is_banned: true,
              matchmaking_cooldown: true,
            },
          },
        },
      });
      lobby = lobbies_by_pk;
    }

    if (!lobby) {
      lobbyId = user.steam_id;
      const { players_by_pk } = await this.hasura.query({
        players_by_pk: {
          __args: {
            steam_id: user.steam_id,
          },
          steam_id: true,
          is_banned: true,
          matchmaking_cooldown: true,
        },
      });

      if (
        !(await this.verifyPlayer({
          steam_id: players_by_pk.steam_id,
          is_banned: players_by_pk.is_banned,
          matchmaking_cooldown: players_by_pk.matchmaking_cooldown,
        }))
      ) {
        return;
      }

      return {
        id: lobbyId,
        players: [
          {
            steam_id: players_by_pk.steam_id,
          },
        ],
      };
    }

    const captain = lobby.players.find((player) => {
      return player.steam_id === user.steam_id && player.captain === true;
    });

    if (!captain) {
      this.logger.warn(`${user.steam_id} is not a captain of ${lobbyId}`);
      return;
    }

    for (const { player } of lobby.players) {
      if (
        !(await this.verifyPlayer({
          steam_id: player.steam_id,
          is_banned: player.is_banned,
          matchmaking_cooldown: player.matchmaking_cooldown,
        }))
      ) {
        return;
      }
    }

    return {
      id: lobbyId,
      players: lobby.players,
    };
  }

  private async getCurrentLobbyId(steamId: string) {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        current_lobby_id: true,
      },
    });

    return players_by_pk.current_lobby_id || steamId;
  }

  private async verifyPlayer(status: VerifyPlayerStatus): Promise<boolean> {
    // TDOO - use SET to check if they are already in queue
    const existingUserInQueue = await this.getLobbyDetails(status.steam_id);

    if (existingUserInQueue) {
      this.logger.warn(`${status.steam_id} player already in queue`);
      return false;
    }

    if (status.matchmaking_cooldown) {
      this.logger.warn(`${status.steam_id} is in matchmaking cooldown`);
      return false;
    }

    if (status.is_banned) {
      this.logger.warn(`${status.steam_id} is banned`);
      return false;
    }

    return true;
  }

  private async getAverageLobbyRank(lobbyId: string) {
    // Implement the logic to calculate the average rank of the players in the lobby
    // This is a placeholder and should be replaced with the actual implementation
    return 0; // Placeholder return, actual implementation needed
  }
}
