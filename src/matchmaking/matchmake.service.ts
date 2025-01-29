import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { e_match_types_enum } from "generated";
import { HasuraService } from "src/hasura/hasura.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingDetailsCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";

interface Team {
  lobbies: string[];
  players: string[];
  avgRank: number;
}

interface Lobby {
  type: e_match_types_enum;
  regions: string[];
  joinedAt: Date;
  lobbyId: string;
  players: string[];
  regionPositions: Record<string, number>;
  avgRank: number;
}

@Injectable()
export class MatchmakeService {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly redisManager: RedisManagerService,
    public readonly matchAssistant: MatchAssistantService,
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
    if (!(await this.acuireLock(type, region))) {
      this.logger.warn("Unable to acquire lock");
      return;
    }

    try {
      const queueKey = getMatchmakingRankCacheKey(type, region);

      // TODO - its possible, but highly unlikley we will ever runinto the issue of too many lobbies in the queue
      const lobbiesData = await this.redis.zrange(
        queueKey,
        0,
        -1,
        "WITHSCORES",
      );

      let lobbies = await this.processLobbyData(lobbiesData);

      if (lobbies.length === 0) {
        this.logger.warn("Not enough lobbies");
        return;
      }

      // sort lobbies by a weighted score combining rank difference and wait time
      lobbies = lobbies.sort((a, b) => {
        // normalize wait times to 0-1 range (longer wait = higher priority)
        const aWaitTime = (Date.now() - a.joinedAt) / 1000;
        const bWaitTime = (Date.now() - b.joinedAt) / 1000;

        const maxWaitTime = Math.max(aWaitTime, bWaitTime);

        const normalizedAWait = aWaitTime / maxWaitTime;
        const normalizedBWait = bWaitTime / maxWaitTime;

        // weight rank differences more heavily (0.7) than wait time (0.3)
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
      let currentGroup = [lobbies.at(0)];

      for (const currentLobby of lobbies.slice(1)) {
        const firstLobbyInGroup = currentGroup.at(0);

        // calculate wait time in minutes
        const waitTimeMinutes = Math.floor(
          (Date.now() - firstLobbyInGroup.joinedAt.getTime()) / (1000 * 60),
        );

        // maximum allowed rank difference increases by 100 for each minute waited
        const maxRankDiff = 100 * (waitTimeMinutes + 1);

        // check if current lobby's rank is within acceptable range
        if (
          Math.abs(currentLobby.avgRank - firstLobbyInGroup.avgRank) <=
          maxRankDiff
        ) {
          currentGroup.push(currentLobby);
          continue;
        }

        // start new group if rank difference is too high
        if (currentGroup.length > 0) {
          groupedLobbies.push([...currentGroup]);
        }
        currentGroup = [currentLobby];
      }

      // add final group
      if (currentGroup.length > 0) {
        groupedLobbies.push(currentGroup);
      }

      for (const group of groupedLobbies) {
        this.createMatches(region, type, group);
      }
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

  public async processLobbyData(lobbiesData: string[]) {
    const lobbyDetails = [];

    for (let i = 0; i < lobbiesData.length; i += 2) {
      const details = await this.matchmakingLobbyService.getLobbyDetails(
        lobbiesData[i],
      );
      if (details) {
        lobbyDetails.push({
          ...details,
          avgRank: lobbiesData[i + 1],
          joinedAt: new Date(details.joinedAt),
        });
      }
    }

    return lobbyDetails;
  }

  public createMatches(
    region: string,
    type: e_match_types_enum,
    lobbies: Array<Lobby>,
  ): Promise<void> {
    const requiredPlayers = type === "Wingman" ? 4 : 10;
    const totalPlayers = lobbies.reduce(
      (acc, lobby) => acc + lobby.players.length,
      0,
    );

    if (lobbies.length === 0 || totalPlayers !== requiredPlayers) {
      return;
    }

    // try to make as many valid matches as possible
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

    const lobbiesAdded: Array<number> = [];
    const playersPerTeam = requiredPlayers / 2;

    // try to fill teams with available lobbies
    for (let lobbyIndex = 0; lobbyIndex < lobbies.length; lobbyIndex++) {
      const lobby = lobbies[lobbyIndex];

      if (team1.players.length + lobby.players.length <= playersPerTeam) {
        team1.players.push(...lobby.players);
        team1.lobbies.push(lobby.lobbyId);
        team1.avgRank =
          (team1.avgRank * (team1.lobbies.length - 1) + lobby.avgRank) /
          team1.lobbies.length;
        lobbiesAdded.push(lobbyIndex);
      } else if (
        team2.players.length + lobby.players.length <=
        playersPerTeam
      ) {
        team2.players.push(...lobby.players);
        team2.lobbies.push(lobby.lobbyId);
        team2.avgRank =
          (team2.avgRank * (team2.lobbies.length - 1) + lobby.avgRank) /
          team2.lobbies.length;
        lobbies.splice(lobbies.indexOf(lobby), 1);
        lobbiesAdded.push(lobbyIndex);
      }
    }

    for (const lobbyIndex of lobbiesAdded) {
      lobbies.splice(lobbyIndex, 1);
    }

    // check if we have valid teams for this match
    if (
      team1.players.length === playersPerTeam &&
      team2.players.length === playersPerTeam
    ) {
      void this.createMatchConfirmation(region, type, {
        team1,
        team2,
      });
    }

    if (lobbies.length > 0) {
      this.createMatches(region, type, lobbies);
    }
  }

  public async createMatchConfirmation(
    region: string,
    type: e_match_types_enum,
    players: { team1: Team; team2: Team },
  ) {
    // -create lock per lobby
    // -verify lobbies still available

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

    const { team1, team2 } = players;
    const allLobbies = [...team1.lobbies, ...team2.lobbies];

    /**
     * remove the lobbies from the queue and rank cache
     */
    const cleanupPipeline = this.redis.pipeline();

    cleanupPipeline.zrem(
      getMatchmakingQueueCacheKey(type, region),
      ...allLobbies,
    );
    cleanupPipeline.zrem(
      getMatchmakingRankCacheKey(type, region),
      ...allLobbies,
    );

    await cleanupPipeline.exec();

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 30);

    const confirmationId = uuidv4();

    this.setConfirmationDetails(region, type, confirmationId, team1, team2);

    for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
      await this.matchmakingLobbyService.setMatchConformationIdForLobby(
        lobbyId,
        confirmationId,
      );
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
    }

    this.matchAssistant.cancelMatchMakingDueToReadyCheck(confirmationId);
  }

  private async setConfirmationDetails(
    region: string,
    type: e_match_types_enum,
    confirmationId: string,
    team1: Team,
    team2: Team,
  ) {
    await this.redis.hset(getMatchmakingConformationCacheKey(confirmationId), {
      type,
      region,
      expiresAt: new Date().toISOString(),
      steamIds: JSON.stringify([...team1.players, ...team2.players]),
    });
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
}
