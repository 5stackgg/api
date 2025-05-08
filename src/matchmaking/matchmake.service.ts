import Redis from "ioredis";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { e_match_types_enum } from "generated";
import { InjectQueue } from "@nestjs/bullmq";
import { MatchmakingTeam } from "./types/MatchmakingTeam";
import { HasuraService } from "src/hasura/hasura.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { MatchmakingQueues } from "./enums/MatchmakingQueues";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";

@Injectable()
export class MatchmakeService {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly redisManager: RedisManagerService,
    public readonly matchAssistant: MatchAssistantService,
    private matchmakingLobbyService: MatchmakingLobbyService,
    @InjectQueue(MatchmakingQueues.Matchmaking) private queue: Queue,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async addLobbyToQueue(lobbyId: string) {
    const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

    // store the lobby's rank in a separate sorted set for quick rank matching
    for (const region of lobby.regions) {
      await this.redis.zadd(
        getMatchmakingRankCacheKey(lobby.type, region),
        lobby.avgRank,
        lobbyId,
      );

      await this.redis.zadd(
        getMatchmakingQueueCacheKey(lobby.type, region),
        0, // score doesn't matter for queue cache
        lobbyId,
      );
    }

    await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
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
        Duel: await this.getNumberOfPlayersInQueue("Duel", region.value),
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
    const lock = await this.aquireMatchmakeRegionLock(region);
    if (!lock) {
      return;
    }

    const queueKey = getMatchmakingRankCacheKey(type, region);

    // TODO - its possible, but highly unlikley we will ever runinto the issue of too many lobbies in the queue
    const lobbiesData = await this.redis.zrange(queueKey, 0, -1, "WITHSCORES");

    let lobbies = await this.processLobbyData(lobbiesData);

    if (lobbies.length === 0) {
      return;
    }

    // sort lobbies by a weighted score combining rank difference and wait time
    lobbies = lobbies.sort((a, b) => {
      // normalize wait times to 0-1 range (longer wait = higher priority)
      const aWaitTime = (Date.now() - a.joinedAt.getTime()) / 1000;
      const bWaitTime = (Date.now() - b.joinedAt.getTime()) / 1000;

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

    const createMatchesPromises = [];

    for (const group of groupedLobbies) {
      createMatchesPromises.push(this.createMatches(region, type, group));
    }

    // once all results are returned as false we no longer need to matchmake
    const results = await Promise.all(createMatchesPromises).finally(() => {
      void this.releaseMatchmakeRegionLock(region);
    });

    if (!results.some((result) => result === true)) {
      return;
    }

    await this.matchmake(type, region);
  }

  private async processLobbyData(
    lobbiesData: string[],
  ): Promise<MatchmakingLobby[]> {
    const lobbyDetails = [];

    for (let i = 0; i < lobbiesData.length; i += 2) {
      const details = await this.matchmakingLobbyService.getLobbyDetails(
        lobbiesData[i],
      );

      if (!details) {
        continue;
      }

      if (details.players.length === ExpectedPlayers[details.type]) {
        const lock = await this.accquireLobbyLock(details.lobbyId);
        if (!lock) {
          continue;
        }

        const shuffledPlayers = [...details.players].sort(
          () => Math.random() - 0.5,
        );
        const halfLength = Math.floor(shuffledPlayers.length / 2);

        const team1: MatchmakingTeam = {
          players: shuffledPlayers.slice(0, halfLength),
          lobbies: [],
          avgRank: 0,
        };
        const team2: MatchmakingTeam = {
          players: shuffledPlayers.slice(halfLength),
          lobbies: [],
          avgRank: 0,
        };

        team1.lobbies.push(details.lobbyId);
        team2.lobbies.push(details.lobbyId);

        team1.avgRank = details.avgRank;
        team2.avgRank = details.avgRank;

        const region = details.regions.at(0);

        await this.createMatchConfirmation(region, details.type, {
          team1,
          team2,
        });

        continue;
      }
      lobbyDetails.push({
        ...details,
        avgRank: parseInt(lobbiesData[i + 1]),
        joinedAt: new Date(details.joinedAt),
      });
    }

    return lobbyDetails;
  }

  private async createMatches(
    region: string,
    type: e_match_types_enum,
    lobbies: Array<MatchmakingLobby>,
  ): Promise<boolean> {
    const requiredPlayers = ExpectedPlayers[type];
    const totalPlayers = lobbies.reduce(
      (acc, lobby) => acc + lobby.players.length,
      0,
    );

    if (lobbies.length === 0 || totalPlayers < requiredPlayers) {
      return false;
    }

    // try to make as many valid matches as possible
    const team1: MatchmakingTeam = {
      players: [],
      lobbies: [],
      avgRank: 0,
    };
    const team2: MatchmakingTeam = {
      players: [],
      lobbies: [],
      avgRank: 0,
    };

    const lobbiesAdded: Array<number> = [];
    const playersPerTeam = requiredPlayers / 2;

    let lobbyLocks = new Set<string>();

    // try to fill teams with available lobbies
    // if they are unable to accuire the lock, it means they are already being matched, or another region is trying to matchmake
    for (let lobbyIndex = 0; lobbyIndex < lobbies.length; lobbyIndex++) {
      const lobby = lobbies[lobbyIndex];
      if (team1.players.length + lobby.players.length <= playersPerTeam) {
        const lock = await this.accquireLobbyLock(lobby.lobbyId);
        if (!lock) {
          continue;
        }

        lobbyLocks.add(lobby.lobbyId);

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
        const lock = await this.accquireLobbyLock(lobby.lobbyId);
        if (!lock) {
          continue;
        }
        lobbyLocks.add(lobby.lobbyId);

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
      // lobby locks will be released after confimrmation
      for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
        lobbyLocks.delete(lobbyId);
      }

      await this.createMatchConfirmation(region, type, {
        team1,
        team2,
      });
    }

    // only try to re-matchmake lobbies that we were able to accuire a lock for
    const lobbiesToMatch = lobbies.filter((lobby) =>
      lobbyLocks.has(lobby.lobbyId),
    );
    if (lobbiesToMatch.length > 0) {
      for (const lobby of lobbiesToMatch) {
        await this.releaseLobbyLock(lobby.lobbyId, 0);
      }
      await this.createMatches(region, type, lobbiesToMatch);
    }
  }

  private async aquireMatchmakeRegionLock(region: string): Promise<boolean> {
    const lockKey = `matchmaking:lock:${region}`;

    const result = await this.redis.set(lockKey, 1, "EX", 60, "NX");

    if (result === null) {
      return false;
    }

    return true;
  }

  private async releaseMatchmakeRegionLock(region: string) {
    const lockKey = `matchmaking:lock:${region}`;
    await this.redis.del(lockKey);
  }

  private async accquireLobbyLock(lobbyId: string): Promise<boolean> {
    const lockKey = `matchmaking:lock:${lobbyId}`;

    const result = await this.redis.set(lockKey, 1, "EX", 10, "NX");

    if (result === null) {
      return false;
    }

    return true;
  }

  private async releaseLobbyLock(lobbyId: string, seconds: number) {
    const lockKey = `matchmaking:lock:${lobbyId}`;
    await this.redis.expire(lockKey, seconds);
  }

  // TODO - watch for a player leaving a lobby and force the entire lobby to be left the queue with an error

  private async createMatchConfirmation(
    region: string,
    type: e_match_types_enum,
    players: { team1: MatchmakingTeam; team2: MatchmakingTeam },
  ) {
    if (!region) {
      throw new Error("Region is required");
    }
    const { team1, team2 } = players;

    const allLobbies = new Set([...team1.lobbies, ...team2.lobbies]);

    for (const lobby of allLobbies) {
      await this.matchmakingLobbyService.removeLobbyFromQueue(lobby);
    }

    for (const lobbyId of allLobbies) {
      void this.releaseLobbyLock(lobbyId, 30);
    }

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

    this.cancelMatchMakingDueToReadyCheck(confirmationId);
  }

  public async cancelMatchMakingDueToReadyCheck(confirmationId: string) {
    await this.queue.add(
      "CancelMatchMaking",
      {
        confirmationId,
      },
      {
        delay: 30 * 1000,
        jobId: `matchmaking:cancel:${confirmationId}`,
      },
    );
  }

  private async removeCancelMatchMakingJob(confirmationId: string) {
    await this.queue.remove(`matchmaking:cancel:${confirmationId}`);
  }

  private async setConfirmationDetails(
    region: string,
    type: e_match_types_enum,
    confirmationId: string,
    team1: MatchmakingTeam,
    team2: MatchmakingTeam,
  ) {
    await this.redis.hset(getMatchmakingConformationCacheKey(confirmationId), {
      type,
      region,
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      lobbyIds: JSON.stringify([...team1.lobbies, ...team2.lobbies]),
      team1: JSON.stringify(team1.players),
      team2: JSON.stringify(team2.players),
    });
  }

  public async removeConfirmationDetails(confirmationId: string) {
    await this.redis.hdel(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
    );

    await this.redis.del(getMatchmakingConformationCacheKey(confirmationId));
  }

  public async getMatchConfirmationDetails(confirmationId: string): Promise<{
    type: e_match_types_enum;
    region: string;
    lobbyIds: string[];
    team1: string[];
    team2: string[];
    matchId: string;
    expiresAt: string;
    confirmed: string[];
  }> {
    const { type, region, lobbyIds, team1, team2, matchId, expiresAt } =
      await this.redis.hgetall(
        getMatchmakingConformationCacheKey(confirmationId),
      );

    const confirmed = await this.redis.hgetall(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
    );

    return {
      region,
      matchId,
      expiresAt,
      type: type as e_match_types_enum,
      team1: JSON.parse(team1 || "[]"),
      team2: JSON.parse(team2 || "[]"),
      lobbyIds: JSON.parse(lobbyIds || "[]"),
      confirmed: Object.keys(confirmed),
    };
  }

  public async cancelMatchMakingByMatchId(matchId: string) {
    const confirmationId = await this.redis.get(
      `matches:confirmation:${matchId}`,
    );

    if (confirmationId) {
      await this.cancelMatchMaking(confirmationId);
    }

    await this.redis.del(`matches:confirmation:${matchId}`);
  }

  public async cancelMatchMaking(confirmationId: string) {
    const { lobbyIds } = await this.getMatchConfirmationDetails(confirmationId);

    for (const lobbyId of lobbyIds) {
      const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

      if (!lobby) {
        continue;
      }

      let requeue = true;
      for (const steamId of lobby.players) {
        const wasReady = await this.redis.hget(
          `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
          steamId,
        );

        if (!wasReady) {
          requeue = false;
          break;
        }
      }

      await this.matchmakingLobbyService.removeLobbyFromQueue(lobbyId);
      await this.matchmakingLobbyService.removeConfirmationIdFromLobby(lobbyId);

      if (!requeue) {
        await this.matchmakingLobbyService.removeLobbyDetails(lobbyId);
        continue;
      }

      await this.addLobbyToQueue(lobbyId);
    }

    await this.removeConfirmationDetails(confirmationId);

    await this.sendRegionStats();
  }

  public async playerConfirmMatchmaking(
    confirmationId: string,
    steamId: string,
  ) {
    await this.redis.hset(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
      steamId,
      1,
    );

    const { lobbyIds, team1, team2, confirmed } =
      await this.getMatchConfirmationDetails(confirmationId);

    if (confirmed.length != team1.length + team2.length) {
      for (const lobbyId of lobbyIds) {
        this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
      }
      return;
    }

    await this.createMatch(confirmationId);
  }

  private async createMatch(confirmationId: string) {
    const { team1, team2, type, region, lobbyIds } =
      await this.getMatchConfirmationDetails(confirmationId);

    await this.removeCancelMatchMakingJob(confirmationId);

    const match = await this.matchAssistant.createMatchBasedOnType(
      type as e_match_types_enum,
      type as e_match_types_enum,
      {
        mr: 12,
        best_of: 1,
        knife: true,
        overtime: true,
        timeout_setting: "Admin",
        region,
      },
    );

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: team1.map((steamId: string) => ({
            steam_id: steamId,
            match_lineup_id: match.lineup_1_id,
          })),
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: team2.map((steamId: string) => ({
            steam_id: steamId,
            match_lineup_id: match.lineup_2_id,
          })),
        },
        __typename: true,
      },
    });

    await this.matchAssistant.updateMatchStatus(match.id, "Veto");

    // add match id to the confirmation details
    await this.redis.hset(
      getMatchmakingConformationCacheKey(confirmationId),
      "matchId",
      match.id,
    );

    await this.redis.set(`matches:confirmation:${match.id}`, confirmationId);

    for (const lobbyId of lobbyIds) {
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
    }
  }
}
