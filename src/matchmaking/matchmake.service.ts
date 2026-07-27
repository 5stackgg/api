import Redis from "ioredis";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { e_map_pool_types_enum, e_match_types_enum } from "generated";
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
import { shuffleSplit } from "./utilities/shuffleSplit";
import { balanceTeams, canFillTeams } from "./utilities/balanceTeams";
import { selectMatchCandidates } from "./utilities/selectMatchCandidates";
import { WINDOW_CAP, winProbability } from "./utilities/matchmakingTuning";

function averageRank(players: Array<{ rank: number }>) {
  return players.reduce((acc, player) => acc + player.rank, 0) / players.length;
}

function toMatchmakingTeam(lobbies: MatchmakingLobby[]): MatchmakingTeam {
  const players = lobbies.flatMap((lobby) => lobby.players);

  return {
    lobbies: lobbies.map((lobby) => lobby.lobbyId),
    players,
    avgRank: averageRank(players),
  };
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
    @InjectQueue(MatchmakingQueues.Matchmaking) private queue: Queue,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async addLobbyToQueue(lobbyId: string) {
    const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);
    if (!lobby) {
      this.logger.warn(`Cannot requeue lobby ${lobbyId} - details not found`);
      return;
    }

    // a non-finite score makes redis reject the whole zadd, which would silently
    // drop the lobby from the queue
    if (!Number.isFinite(lobby.avgRank)) {
      this.logger.error(
        `Cannot queue lobby ${lobbyId} - avgRank is ${lobby.avgRank}`,
      );
      return;
    }

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

    const types: e_match_types_enum[] = ["Duel", "Wingman", "Competitive"];

    const regionStats: Partial<
      Record<string, Partial<Record<e_match_types_enum, number[]>>>
    > = {};

    for (const type of types) {
      const lobbyIndexes = new Map<string, number>();

      for (const region of regions.server_regions) {
        const lobbyIds = await this.redis.zrange(
          getMatchmakingQueueCacheKey(type, region.value),
          0,
          -1,
        );

        const stats = (regionStats[region.value] ??= {});
        stats[type] = lobbyIds.map((lobbyId) => {
          let index = lobbyIndexes.get(lobbyId);
          if (index === undefined) {
            index = lobbyIndexes.size;
            lobbyIndexes.set(lobbyId, index);
          }
          return index;
        });
      }
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

    const lobbies = await this.processLobbyData(lobbiesData, region);

    if (lobbies.length === 0) {
      await this.releaseMatchmakeRegionLock(region);
      return;
    }

    const totalPlayerNotQueued = await this.createMatches(
      region,
      type,
      lobbies,
    ).finally(() => {
      void this.releaseMatchmakeRegionLock(region);
    });

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
    region: string,
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
        const lock = await this.claimLobby(details.lobbyId, details);
        if (!lock) {
          this.logger.warn(
            `Unable to acquire lobby lock for ${details.lobbyId} - lobby is already being processed`,
          );
          continue;
        }

        try {
          // a party that fills the whole match keeps a random split - they
          // queued together for a scrim, not for a rating-balanced game
          const [players1, players2] = shuffleSplit(details.players);

          const team1: MatchmakingTeam = {
            players: players1,
            lobbies: [details.lobbyId],
            avgRank: averageRank(players1),
          };
          const team2: MatchmakingTeam = {
            // both teams come from the same lobby, but the id is only recorded
            // once so the confirmation doesn't process it twice
            players: players2,
            lobbies: [],
            avgRank: averageRank(players2),
          };

          await this.createMatchConfirmation(
            details.regions.includes(region) ? region : details.regions.at(0),
            details.type,
            { team1, team2 },
          );
        } catch (error) {
          this.logger.error(
            `Error creating match confirmation for lobby ${details.lobbyId}:`,
            error,
          );
          await this.releaseLobbyAndRequeue(details.lobbyId);
        }

        continue;
      }
      lobbyDetails.push({
        ...details,
        avgRank: averageRank(details.players),
        joinedAt: new Date(details.joinedAt),
      });
    }

    return lobbyDetails;
  }

  private async createMatches(
    region: string,
    type: e_match_types_enum,
    lobbies: Array<MatchmakingLobby>,
  ): Promise<number> {
    const requiredPlayers = ExpectedPlayers[type];
    const totalPlayers = lobbies.reduce(
      (acc, lobby) => acc + lobby.players.length,
      0,
    );

    if (lobbies.length === 0) {
      return 0;
    }

    if (totalPlayers < requiredPlayers) {
      return totalPlayers;
    }

    // parties are atomic, so a queue can hold enough players and still have no
    // legal split - five duos can never make two teams of five. nothing will
    // change until the queue does, so report 0 rather than spinning the retry.
    if (
      !canFillTeams(
        lobbies.map((lobby) => lobby.players.length),
        requiredPlayers,
      )
    ) {
      this.logger.warn(
        `${type}/${region}: ${totalPlayers} queued but the party sizes cannot fill two lineups`,
      );
      return 0;
    }

    const selection = selectMatchCandidates(lobbies, requiredPlayers);

    if (!selection) {
      return totalPlayers;
    }

    // claim in preference order. selectMatchCandidates returns every lobby, not
    // just the window, so lobbies that fail to claim are topped up from the tail.
    const claimed: Array<MatchmakingLobby> = [];
    const pending = new Set<string>();

    for (const lobby of selection.candidates) {
      if (claimed.length >= WINDOW_CAP) {
        break;
      }

      let acquired = false;
      try {
        acquired = await this.claimLobby(lobby.lobbyId, lobby);
      } catch (error) {
        this.logger.error(`Error claiming lobby ${lobby.lobbyId}:`, error);
        continue;
      }

      if (!acquired) {
        // another region is matchmaking it - we never owned it, so it must not
        // be requeued here
        this.logger.warn(
          `Unable to acquire lobby lock for ${lobby.lobbyId} - lobby is already being processed`,
        );
        continue;
      }

      claimed.push(lobby);
      pending.add(lobby.lobbyId);
    }

    try {
      // everything below is pure until the confirmation, so the teams we pick
      // are guaranteed to still be ours
      let balanced = balanceTeams(claimed, requiredPlayers);

      if (!balanced) {
        // the anchor itself may be what makes the split impossible
        balanced = balanceTeams(claimed, requiredPlayers, { pinAnchor: false });
      }

      if (!balanced) {
        this.logger.warn(
          `${type}/${region}: no valid split among ${claimed.length} claimed lobbies`,
        );
        return totalPlayers;
      }

      this.logger.log(
        `${type}/${region} matched: elo diff ${balanced.avgRankDifference.toFixed(
          1,
        )} (win probability ${winProbability(
          balanced.avgRankDifference,
        ).toFixed(3)}), spread ${balanced.spread}, cost ${balanced.cost.toFixed(
          1,
        )}, ${balanced.nodesVisited} nodes, optimal ${balanced.exhausted}`,
      );

      const team1 = toMatchmakingTeam(balanced.team1);
      const team2 = toMatchmakingTeam(balanced.team2);

      // hand the locks to the confirmation, which re-ttls them, before awaiting
      for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
        pending.delete(lobbyId);
      }

      try {
        await this.createMatchConfirmation(region, type, { team1, team2 });
      } catch (error) {
        this.logger.error(`Error creating match confirmation:`, error);
        for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
          pending.add(lobbyId);
        }
        return totalPlayers;
      }

      return totalPlayers - requiredPlayers;
    } finally {
      // single settle path - every claimed lobby is either in the confirmed
      // match or requeued here, exactly once, even if the above threw
      for (const lobbyId of pending) {
        try {
          await this.releaseLobbyAndRequeue(lobbyId);
        } catch (error) {
          this.logger.error(`Failed to requeue lobby ${lobbyId}:`, error);
        }
      }
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

  private static readonly CLAIM_LOBBY_SCRIPT = `
    local acquired = redis.call('SET', KEYS[1], 1, 'EX', ARGV[2], 'NX')
    if not acquired then
      return 0
    end
    for i = 2, #KEYS do
      redis.call('ZREM', KEYS[i], ARGV[1])
    end
    return 1
  `;

  private async claimLobby(
    lobbyId: string,
    existingLobby?: MatchmakingLobby,
  ): Promise<boolean> {
    const lobby =
      existingLobby ??
      (await this.matchmakingLobbyService.getLobbyDetails(lobbyId));
    if (!lobby) {
      return false;
    }

    const lockKey = `matchmaking:lock:${lobbyId}`;
    const keys: string[] = [lockKey];

    for (const region of lobby.regions) {
      keys.push(getMatchmakingQueueCacheKey(lobby.type, region));
      keys.push(getMatchmakingRankCacheKey(lobby.type, region));
    }

    const result = await this.redis.eval(
      MatchmakeService.CLAIM_LOBBY_SCRIPT,
      keys.length,
      ...keys,
      lobbyId,
      10, // TTL in seconds
    );

    return result === 1;
  }

  private async releaseLobbyAndRequeue(lobbyId: string): Promise<void> {
    await this.releaseLobbyLock(lobbyId, 0);
    await this.addLobbyToQueue(lobbyId);
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
    team1: { steam_id: string; rank: number }[];
    team2: { steam_id: string; rank: number }[];
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
        for (const player of lobby.players) {
          const wasReady = await this.redis.hget(
            `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
            player.steam_id,
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

    // e_map_pool_types_enum doesn't include Premier/Faceit (imports only).
    const mapPoolType: e_map_pool_types_enum =
      type === "Premier" || type === "Faceit" ? "Competitive" : type;
    const match = await this.matchAssistant.createMatchBasedOnType(
      type,
      mapPoolType,
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
          objects: team1.map((player) => ({
            steam_id: player.steam_id,
            match_lineup_id: match.lineup_1_id,
          })),
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: team2.map((player) => ({
            steam_id: player.steam_id,
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
