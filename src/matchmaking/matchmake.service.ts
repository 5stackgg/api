import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { e_match_types_enum } from "generated";
import { HasuraService } from "src/hasura/hasura.service";
import { Logger } from "@nestjs/common";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingDetailsCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";

interface TeamCombination {
  lobbies: string[];
  players: string[];
  avgRank: number;
}

@Injectable()
export class MatchmakeService {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly redisManager: RedisManagerService,
    private matchmakingLobbyService: MatchmakingLobbyService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async getNumberOfPlayersInQueue(
    type: e_match_types_enum,
    region: string,
  ) {
    return await this.redis.zcard(getMatchmakingQueueCacheKey(type, region));
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

  public async matchmake(type: e_match_types_enum, region: string) {
    const queueSize = await this.redis.zcard(
      getMatchmakingQueueCacheKey(type, region),
    );

    if (queueSize < 2) {
      return;
    }

    const aquiredLock = await this.acuireLock(type, region);

    if (!aquiredLock) {
      this.logger.warn("Unable to acquire lock");
      return;
    }

    const requiredPlayers = type === "Wingman" ? 4 : 10;

    try {
      await this.searchForMatches(type, region, requiredPlayers / 2);
    } finally {
      await this.releaseLock(type, region);
    }
  }

  public async processMatchmakingBatch(
    type: e_match_types_enum,
    region: string,
    start: number,
    batchSize: number,
    playersPerTeam: number,
  ) {
    const queueKey = getMatchmakingQueueCacheKey(type, region);
    const rankKey = getMatchmakingRankCacheKey(type, region);

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

  public async verifyLobbiesStillAvailable(
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

  public async processLobbyDetails(lobbiesData: string[]) {
    const lobbyDetails = [];

    for (let i = 0; i < lobbiesData.length; i += 3) {
      const details = await this.matchmakingLobbyService.getLobbyDetails(
        lobbiesData[i],
      );
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

  public async findValidTeams(
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

  public findTeamCombinations(
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

  public async confirmMatchMaking(
    type: e_match_types_enum,
    region: string,
    players: Array<string>,
  ) {
    // const expiresAt = new Date();
    // expiresAt.setSeconds(expiresAt.getSeconds() + 30);
    // const confirmationId = uuidv4();
    // await this.redis.hset(
    //   getMatchmakingConformationCacheKey(confirmationId),
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
    //     getmatchMakingDetailsCacheKey(steamId),
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

  public async getMatchConfirmationDetails(confirmationId: string) {
    const { type, region, steamIds, confirmed, matchId, expiresAt } =
      await this.redis.hgetall(
        getMatchmakingConformationCacheKey(confirmationId),
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

  public async getAverageLobbyRank(lobbyId: string) {
    // Implement the logic to calculate the average rank of the players in the lobby
    // This is a placeholder and should be replaced with the actual implementation
    return 0; // Placeholder return, actual implementation needed
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
    //       getMatchmakingConformationCacheKey(confirmationId),
    //       steamId,
    //     );

    //     if (wasReady) {
    //       /**
    //        * if they wre ready, we want to requeue them into the queue
    //        */
    //       // I thin this was to remove the confirmation ID from the match?
    //       // await this.redis.hdel(
    //       //   getmatchMakingDetailsCacheKey(steamId),
    //       //   "confirmationId",
    //       // );

    //       const { regions, joinedAt } = await this.getLobbyDetails(steamId);
    //       for (const region of regions) {
    //         // TODO - re-add them to the queue
    //         // await this.redis.zadd(
    //         //   getMatchMakingQueueCacheKey(type, region),
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
    //   getMatchmakingConformationCacheKey(confirmationId),
    // );

    // await this.sendRegionStats();

    // if (!readyCheckFailed) {
    //   return;
    // }

    // this.matchmake(type, region);
  }

  private async acuireLock(type: e_match_types_enum, region: string) {
    const lockKey = `matchmaking-lock:${type}:${region}`;
    const lockValue = Date.now().toString();
    return !!(await this.redis.set(
      lockKey,
      lockValue,
      "EX",
      10,
      "NX",
    ));
  }

  private async releaseLock(type: e_match_types_enum, region: string) {
    const lockKey = `matchmaking-lock:${type}:${region}`;
    const lockValue = Date.now().toString();
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

  private async searchForMatches(
    type: e_match_types_enum,
    region: string,
    playersPerTeam: number,
  ) {
    const queueKey = getMatchmakingQueueCacheKey(type, region);
    const rankKey = getMatchmakingRankCacheKey(type, region);

    const oldestLobby = await this._getOldestLobby(queueKey, rankKey);
    if (!oldestLobby) {
      this.logger.debug("No lobbies in queue");
      return;
    }

    const [oldestLobbyId, joinTime, rankStr] = oldestLobby;
    const oldestLobbyDetails = await this._validateOldestLobby(oldestLobbyId);
    if (!oldestLobbyDetails) return;

    const baseRank = parseFloat(rankStr);
    const waitTimePriority = Math.floor(
      (Date.now() - parseInt(joinTime)) / 10000,
    );
    const rankRange = Math.min(50 + waitTimePriority * 10, 500);

    const lobbyDetails = await this._getLobbiesInRange(
      queueKey,
      rankKey,
      baseRank,
      rankRange,
    );
    if (lobbyDetails.length === 0) return;

    const match = await this.findValidTeams(
      lobbyDetails[0],
      lobbyDetails,
      playersPerTeam,
      rankRange,
    );

    if (match) {
      await this._handleMatchFound(match, type, region, queueKey, rankKey);
    } else {
      this.logger.debug("No suitable match found in this iteration");
    }
  }

  private async _getOldestLobby(queueKey: string, rankKey: string) {
    return (await this.redis.eval(
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
  }

  private async _validateOldestLobby(oldestLobbyId: string) {
    const oldestLobbyDetails =
      await this.matchmakingLobbyService.getLobbyDetails(oldestLobbyId);
    if (!oldestLobbyDetails) {
      this.logger.warn(`Invalid oldest lobby found: ${oldestLobbyId}`);
      await this.matchmakingLobbyService.removeLobbyFromQueue(oldestLobbyId);
      return null;
    }
    return oldestLobbyDetails;
  }

  private async _getLobbiesInRange(
    queueKey: string,
    rankKey: string,
    baseRank: number,
    rankRange: number,
  ) {
    const lobbiesInRange = (await this.redis.eval(
      `
      local rankKey = KEYS[1]
      local queueKey = KEYS[2]
      local baseRank = tonumber(ARGV[1])
      local rankRange = tonumber(ARGV[2])
      local maxLobbies = tonumber(ARGV[3])
      
      local minRank = baseRank - rankRange
      local maxRank = baseRank + rankRange
      
      local lobbies = redis.call('ZRANGEBYSCORE', rankKey, minRank, maxRank, 'WITHSCORES')
      local result = {}
      local count = 0
      
      for i = 1, #lobbies, 2 do
        if count >= maxLobbies then break end
        
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

    const lobbyDetails = [];
    for (let i = 0; i < lobbiesInRange.length; i += 3) {
      const details = await this.matchmakingLobbyService.getLobbyDetails(
        lobbiesInRange[i],
      );
      if (details) {
        lobbyDetails.push({
          id: lobbiesInRange[i],
          players: details.players,
          avgRank: parseFloat(lobbiesInRange[i + 2]),
          joinTime: parseInt(lobbiesInRange[i + 1]),
        });
      }
    }

    return lobbyDetails.sort((a, b) => a.joinTime - b.joinTime);
  }

  private async _handleMatchFound(
    match: { team1: TeamCombination; team2: TeamCombination },
    type: e_match_types_enum,
    region: string,
    queueKey: string,
    rankKey: string,
  ) {
    const { team1, team2 } = match;
    this.logger.debug(
      `Found match! Team1: ${team1.lobbies.join(",")} vs Team2: ${team2.lobbies.join(",")}`,
    );

    const allPlayers = [...team1.players, ...team2.players];
    await this.confirmMatchMaking(type, region, allPlayers);

    const allLobbies = [...team1.lobbies, ...team2.lobbies];
    const cleanupPipeline = this.redis.pipeline();

    cleanupPipeline.zrem(queueKey, ...allLobbies);
    cleanupPipeline.zrem(rankKey, ...allLobbies);

    for (const lobbyId of allLobbies) {
      cleanupPipeline.del(getMatchmakingDetailsCacheKey(lobbyId));
    }

    await cleanupPipeline.exec();
  }
}
