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

interface Team {
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

  public async createMatches(
    type: e_match_types_enum,
    lobbies: Array<{ id: string; players: string[]; avgRank: number }>,
    playersPerTeam: number,
  ): Promise<void> {
    const requiredPlayers = type === "Wingman" ? 4 : 10;

    const matches: Array<{ team1: Team; team2: Team }> = [];
    const usedLobbies = new Set<string>();

    // Try to make as many valid matches as possible
    while (true) {
      // Initialize teams for this potential match
      const team1: Team = {
        players: [],
        lobbies: [],
        avgRank: 0,
      };
      const team2: Team = {
        players: [],
        lobbies: [],
        avgRank: 0,
      };

      if (lobbies.length === 0) {
        break;
      }

      // Try to fill teams with available lobbies
      for (const lobby of lobbies) {
        if (team1.players.length + lobby.players.length <= playersPerTeam) {
          team1.players.push(...lobby.players);
          team1.lobbies.push(lobby.id);
          team1.avgRank =
            (team1.avgRank * (team1.lobbies.length - 1) + lobby.avgRank) /
            team1.lobbies.length;
          lobbies.splice(lobbies.indexOf(lobby), 1);
        } else if (
          team2.players.length + lobby.players.length <=
          playersPerTeam
        ) {
          team2.players.push(...lobby.players);
          team2.lobbies.push(lobby.id);
          team2.avgRank =
            (team2.avgRank * (team2.lobbies.length - 1) + lobby.avgRank) /
            team2.lobbies.length;
          lobbies.splice(lobbies.indexOf(lobby), 1);
        }
      }

      // Check if we have valid teams for this match
      if (
        team1.players.length === playersPerTeam &&
        team2.players.length === playersPerTeam
      ) {
        matches.push({ team1, team2 });
      } else {
        // If we can't make a valid match with remaining lobbies, break
        break;
      }
    }

    // Process all found matches
    for (const match of matches) {
      // await this._handleMatchFound(match, type, region, getMatchmakingQueueCacheKey(type, region), getMatchmakingRankCacheKey(type, region));
    }
  }

  public async confirmMatchMaking(
    type: e_match_types_enum,
    region: string,
    players: Array<string>,
  ) {
    // if (
    //   !(await this.verifyLobbiesStillAvailable(
    //     mathcedLobbies.map((lobby) => {
    //       return lobby.id;
    //     }),
    //     queueKey,
    //   ))
    // ) {
    //   return;
    // }
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
    return !!(await this.redis.set(lockKey, lockValue, "EX", 10, "NX"));
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

    // TODO - its possible, but highly unlikley we will ever runinto the issue of too many lobbies in the queue
    const lobbiesData = await this.redis.zrange(queueKey, 0, -1, "WITHSCORES");

    if (!lobbiesData.length) {
      return;
    }

    // Process lobby details to get players and ranks
    const lobbyDetails = await this.processLobbyDetails(lobbiesData);

    // Sort lobbies by a weighted score combining rank difference and wait time
    const now = Date.now();
    const mathcedLobbies = lobbyDetails.sort((a, b) => {
      // Normalize wait times to 0-1 range (longer wait = higher priority)
      const aWaitTime = (now - a.joinTime) / 1000;
      const bWaitTime = (now - b.joinTime) / 1000;

      const maxWaitTime = Math.max(aWaitTime, bWaitTime);

      const normalizedAWait = aWaitTime / maxWaitTime;
      const normalizedBWait = bWaitTime / maxWaitTime;

      // Weight rank differences more heavily (0.7) than wait time (0.3)
      const rankWeight = 0.7;
      const waitWeight = 0.3;

      return (
        rankWeight * b.avgRank +
        waitWeight * normalizedBWait -
        rankWeight * a.avgRank +
        waitWeight * normalizedAWait
      );
    });

    // group lobbies based on rank differences that expand with wait time
    const groupedLobbies = [];
    let currentGroup = [mathcedLobbies[0]];

    for (const currentLobby of mathcedLobbies.slice(1)) {
      const firstLobbyInGroup = currentGroup[0];

      // Calculate wait time in minutes
      const waitTimeMinutes = Math.floor(
        (now - firstLobbyInGroup.joinTime) / (1000 * 60),
      );

      // Maximum allowed rank difference increases by 100 for each minute waited
      const maxRankDiff = 100 * (waitTimeMinutes + 1);

      // Check if current lobby's rank is within acceptable range
      if (
        Math.abs(currentLobby.avgRank - firstLobbyInGroup.avgRank) <=
        maxRankDiff
      ) {
        currentGroup.push(currentLobby);
        continue;
      }

      // Start new group if rank difference is too high
      if (currentGroup.length > 0) {
        groupedLobbies.push([...currentGroup]);
      }
      currentGroup = [currentLobby];
    }

    // Add final group
    if (currentGroup.length > 0) {
      groupedLobbies.push(currentGroup);
    }

    for (const group of groupedLobbies) {
      await this.createMatches(type, group, playersPerTeam);
    }
  }

  private async _handleMatchFound(
    match: { team1: Team; team2: Team },
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
