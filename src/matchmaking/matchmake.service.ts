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

  // TODO - fix race conditions for matchmaking across multiple regions
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

  public async matchmake(
    type: e_match_types_enum,
    region: string,
  ): Promise<void> {
    const lock = await this.aquireMatchmakeRegionLock(region);
    if (!lock) {
      this.logger.warn(
        `Unable to acquire region lock for ${region} - another matchmaking process is running`,
      );
      return;
    }

    // TODO - its possible, but highly unlikley we will ever runinto the issue of too many lobbies in the queue
    const lobbiesData = await this.redis.zrange(
      getMatchmakingRankCacheKey(type, region),
      0,
      -1,
      "WITHSCORES",
    );

    let lobbies = await this.processLobbyData(lobbiesData);

    if (lobbies.length === 0) {
      await this.releaseMatchmakeRegionLock(region);
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

      // TODO - check if rank difference feature is enabled
      const rankDiffEnabled = false;

      if (!rankDiffEnabled) {
        // if rank difference feature is disabled, just add lobbies in order
        currentGroup.push(currentLobby);
        continue;
      }

      // calculate wait time in seconds
      const waitTimeSeconds = Math.max(
        10,
        Math.floor((Date.now() - firstLobbyInGroup.joinedAt.getTime()) / 1000),
      );

      // maximum allowed rank difference increases proportionally with wait time (100 per minute)
      const maxRankDiff = 25 * waitTimeSeconds;

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

    const totalPlayerNotQueued = results.reduce(
      (acc, result) => acc + result,
      0,
    );

    if (totalPlayerNotQueued < ExpectedPlayers[type]) {
      await this.releaseMatchmakeRegionLock(region);
      return;
    }

    this.logger.log(
      `${totalPlayerNotQueued} players not queued, expanding search....`,
    );

    // randomize the time to prevent all regions from matchingmake at the same time
    setTimeout(
      () => {
        void this.matchmake(type, region);
      },
      10000 + Math.floor(Math.random() * 10000),
    );
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
          this.logger.warn(
            `Unable to acquire lobby lock for ${details.lobbyId} - lobby is already being processed`,
          );
          continue;
        }

        try {
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
        } catch (error) {
          this.logger.error(
            `Error creating match confirmation for lobby ${details.lobbyId}:`,
            error,
          );
          await this.releaseLobbyLock(details.lobbyId, 0);
        }

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

  // --- Global fairness helpers (no lobby splitting) ---
  // Approximate a lobby's total "rank points" as avgRank * playerCount.
  private lobbyTotalRank(lobby: MatchmakingLobby): number {
    return lobby.avgRank * lobby.players.length;
  }

  private computeTeamAvgRankFromLobbies(lobbies: MatchmakingLobby[]): number {
    const totalPlayers = lobbies.reduce((a, l) => a + l.players.length, 0);
    if (totalPlayers === 0) return 0;

    const totalRank = lobbies.reduce((a, l) => a + this.lobbyTotalRank(l), 0);
    return totalRank / totalPlayers;
  }

  /**
   * Pick exactly `requiredPlayers` players (10 for Competitive) from the available lobbies,
   * and split them into 2 teams of `requiredPlayers/2` players in the most balanced way,
   * WITHOUT splitting any lobby.
   *
   * Returns the chosen lobbies per team (team1Lobbies/team2Lobbies) and usedLobbyIds.
   * If no exact 5v5 split is possible under the no-split constraint, returns null.
   */
  private findBestGlobalMatchSplit(
    lockableLobbies: MatchmakingLobby[],
    requiredPlayers: number,
  ): {
    team1Lobbies: MatchmakingLobby[];
    team2Lobbies: MatchmakingLobby[];
    usedLobbyIds: string[];
  } | null {
    const playersPerTeam = requiredPlayers / 2;

    // Small optimization: larger lobbies first helps pruning.
    const lobbies = [...lockableLobbies].sort(
      (a, b) => b.players.length - a.players.length,
    );

    const sizes = lobbies.map((l) => l.players.length);
    const ranks = lobbies.map((l) => this.lobbyTotalRank(l));

    // Suffix sum of remaining players for pruning.
    const suffixPlayers = new Array(lobbies.length + 1).fill(0);
    for (let i = lobbies.length - 1; i >= 0; i--) {
      suffixPlayers[i] = suffixPlayers[i + 1] + sizes[i];
    }

    type Best = { score: number; team1Idx: number[]; team2Idx: number[] };
    let best: Best | null = null;

    const dfs = (
      i: number,
      pickedPlayers: number,
      team1Players: number,
      team2Players: number,
      team1Rank: number,
      team2Rank: number,
      team1Idx: number[],
      team2Idx: number[],
    ) => {
      if (pickedPlayers > requiredPlayers) return;
      if (team1Players > playersPerTeam) return;
      if (team2Players > playersPerTeam) return;

      // Even if we take everything remaining, we still can't reach requiredPlayers.
      const remainingMax = suffixPlayers[i] ?? 0;
      if (pickedPlayers + remainingMax < requiredPlayers) return;

      // Success: exact 5v5.
      if (
        pickedPlayers === requiredPlayers &&
        team1Players === playersPerTeam &&
        team2Players === playersPerTeam
      ) {
        const avg1 = team1Rank / team1Players;
        const avg2 = team2Rank / team2Players;
        const score = Math.abs(avg1 - avg2);

        if (!best || score < best.score) {
          best = {
            score,
            team1Idx: [...team1Idx],
            team2Idx: [...team2Idx],
          };
        }
        return;
      }

      if (i >= lobbies.length) return;

      const sz = sizes[i];
      const rk = ranks[i];

      // Option 1: skip this lobby (leave it in queue for future).
      dfs(
        i + 1,
        pickedPlayers,
        team1Players,
        team2Players,
        team1Rank,
        team2Rank,
        team1Idx,
        team2Idx,
      );

      // Option 2: take this lobby into team1.
      if (
        pickedPlayers + sz <= requiredPlayers &&
        team1Players + sz <= playersPerTeam
      ) {
        team1Idx.push(i);
        dfs(
          i + 1,
          pickedPlayers + sz,
          team1Players + sz,
          team2Players,
          team1Rank + rk,
          team2Rank,
          team1Idx,
          team2Idx,
        );
        team1Idx.pop();
      }

      // Option 3: take this lobby into team2.
      if (
        pickedPlayers + sz <= requiredPlayers &&
        team2Players + sz <= playersPerTeam
      ) {
        team2Idx.push(i);
        dfs(
          i + 1,
          pickedPlayers + sz,
          team1Players,
          team2Players + sz,
          team1Rank,
          team2Rank + rk,
          team1Idx,
          team2Idx,
        );
        team2Idx.pop();
      }
    };

    dfs(0, 0, 0, 0, 0, 0, [], []);

    if (!best) return null;

    const team1Lobbies = best.team1Idx.map((idx) => lobbies[idx]);
    const team2Lobbies = best.team2Idx.map((idx) => lobbies[idx]);
    const usedLobbyIds = [...team1Lobbies, ...team2Lobbies].map(
      (l) => l.lobbyId,
    );

    return { team1Lobbies, team2Lobbies, usedLobbyIds };
  }

  private async createMatches(
    region: string,
    type: e_match_types_enum,
    lobbies: Array<MatchmakingLobby>,
  ): Promise<number> {
    const requiredPlayers = ExpectedPlayers[type];
    const playersPerTeam = requiredPlayers / 2;

    if (lobbies.length === 0) {
      return 0;
    }

    // If we don't have enough total players across these lobbies, keep them queued.
    const totalPlayers = lobbies.reduce(
      (acc, lobby) => acc + lobby.players.length,
      0,
    );
    if (totalPlayers < requiredPlayers) {
      return totalPlayers;
    }

    // We will keep creating matches as long as we can pick an exact `requiredPlayers` set (e.g. 10),
    // WITHOUT splitting any lobby. Extra players (10~19, 11+, etc.) remain in the queue.
    let remainingLobbies = [...lobbies];

    while (true) {
      const remainingPlayers = remainingLobbies.reduce(
        (acc, lobby) => acc + lobby.players.length,
        0,
      );

      if (remainingPlayers < requiredPlayers) {
        // Not enough left for another match; leave remaining in queue.
        return remainingPlayers;
      }

      // Acquire locks for the lobbies we're allowed to consider this iteration.
      const lockableLobbies: MatchmakingLobby[] = [];
      const lobbyLocks = new Set<string>();

      for (const lobby of remainingLobbies) {
        const lock = await this.accquireLobbyLock(lobby.lobbyId);
        if (!lock) {
          continue;
        }
        lobbyLocks.add(lobby.lobbyId);
        lockableLobbies.push(lobby);
      }

      const lockablePlayers = lockableLobbies.reduce(
        (acc, lobby) => acc + lobby.players.length,
        0,
      );

      // If we can't even lock enough players, release and stop.
      if (lockablePlayers < requiredPlayers) {
        for (const id of lobbyLocks) {
          await this.releaseLobbyLock(id, 0);
        }
        return remainingPlayers;
      }

      // Pick the best possible exact match (e.g. best 10 players) and split into 5v5,
      // WITHOUT splitting any lobby.
      const best = this.findBestGlobalMatchSplit(
        lockableLobbies,
        requiredPlayers,
      );

      if (!best) {
        // Under the no-split constraint, we couldn't form an exact 5v5 with `requiredPlayers`.
        for (const id of lobbyLocks) {
          await this.releaseLobbyLock(id, 0);
        }
        return remainingPlayers;
      }

      const { team1Lobbies, team2Lobbies, usedLobbyIds } = best;

      // Release locks for all lobbies not used in this match so they remain in queue.
      for (const id of lobbyLocks) {
        if (!usedLobbyIds.includes(id)) {
          await this.releaseLobbyLock(id, 0);
        }
      }

      const team1: MatchmakingTeam = {
        lobbies: team1Lobbies.map((l) => l.lobbyId),
        players: team1Lobbies.flatMap((l) => l.players),
        avgRank: this.computeTeamAvgRankFromLobbies(team1Lobbies),
      };

      const team2: MatchmakingTeam = {
        lobbies: team2Lobbies.map((l) => l.lobbyId),
        players: team2Lobbies.flatMap((l) => l.players),
        avgRank: this.computeTeamAvgRankFromLobbies(team2Lobbies),
      };

      // Safety check.
      if (
        team1.players.length !== playersPerTeam ||
        team2.players.length !== playersPerTeam
      ) {
        for (const id of usedLobbyIds) {
          await this.releaseLobbyLock(id, 0);
        }
        return remainingPlayers;
      }

      try {
        // createMatchConfirmation() will remove used lobbies from queue and extend their locks
        // for the ready-check window.
        await this.createMatchConfirmation(region, type, { team1, team2 });
      } catch (error) {
        this.logger.error(`Error creating match confirmation:`, error);
        for (const id of usedLobbyIds) {
          await this.releaseLobbyLock(id, 0);
        }
        return remainingPlayers;
      }

      // Remove used lobbies from this iteration's remaining pool and try to create another match
      // (e.g., 20 players => 2 matches).
      remainingLobbies = remainingLobbies.filter(
        (lobby) => !usedLobbyIds.includes(lobby.lobbyId),
      );
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

  public async releaseLobbyLock(lobbyId: string, seconds: number) {
    const lockKey = `matchmaking:lock:${lobbyId}`;
    await this.redis.expire(lockKey, seconds);
  }

  public async markOffline(steamId: string) {
    await this.queue.add(
      "MarkPlayerOffline",
      {
        steamId,
      },
      {
        delay: 60 * 1000,
        jobId: `matchmaking.mark-offline.${steamId}`,
      },
    );
  }

  public async cancelOffline(steamId: string) {
    await this.queue.remove(`matchmaking.mark-offline.${steamId}`);
  }

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

    await this.setConfirmationDetails(
      region,
      type,
      confirmationId,
      team1,
      team2,
    );

    for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
      await this.matchmakingLobbyService.setMatchConformationIdForLobby(
        lobbyId,
        confirmationId,
      );
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
    }

    await this.cancelMatchMakingDueToReadyCheck(confirmationId);
  }

  public async cancelMatchMakingDueToReadyCheck(confirmationId: string) {
    await this.queue.add(
      "CancelMatchMaking",
      {
        confirmationId,
      },
      {
        delay: 30 * 1000,
        jobId: this.getMatchMakingCancelJobId(confirmationId),
      },
    );
  }

  private async removeCancelMatchMakingJob(confirmationId: string) {
    await this.queue.remove(this.getMatchMakingCancelJobId(confirmationId));
  }

  private getMatchMakingCancelJobId(confirmationId: string) {
    return `matchmaking.cancel.${confirmationId}`;
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
    const confirmedKey = `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`;
    await this.redis.del(confirmedKey);

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
      await this.cancelMatchMaking(confirmationId, true);
    }

    await this.redis.del(`matches:confirmation:${matchId}`);
  }

  public async cancelMatchMaking(confirmationId: string, hasMatch = false) {
    let shouldMatchmake = false;
    const { lobbyIds, type, region } =
      await this.getMatchConfirmationDetails(confirmationId);

    for (const lobbyId of lobbyIds) {
      const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

      if (!lobby) {
        continue;
      }

      let requeue = !hasMatch;
      if (!hasMatch) {
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
      }

      await this.matchmakingLobbyService.removeLobbyFromQueue(lobbyId);
      await this.matchmakingLobbyService.removeConfirmationIdFromLobby(lobbyId);

      if (!requeue) {
        await this.matchmakingLobbyService.removeLobbyDetails(lobbyId);
        continue;
      }

      shouldMatchmake = true;
      await this.addLobbyToQueue(lobbyId);
    }

    await this.removeConfirmationDetails(confirmationId);

    await this.sendRegionStats();

    if (shouldMatchmake) {
      // randomize the time to prevent all regions from matchingmake at the same time
      setTimeout(
        () => {
          void this.matchmake(type, region);
        },
        Math.floor(Math.random() * 10000),
      );
    }
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
        void this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
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
        mr: type === "Competitive" ? 12 : 8,
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

    await this.matchAssistant.updateMatchStatus(match.id, "Live");

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
