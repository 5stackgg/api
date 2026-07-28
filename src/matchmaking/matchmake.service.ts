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
  const players = lobbies.flatMap((lobby) =>
    lobby.players.map((player) => ({
      ...player,
      // A solo queuer's lobbyId is their own steam id (see
      // MatchmakingLobbyService.getPlayerLobby) — not a lobby, and not a
      // uuid. One player is not a party either way.
      lobby_id: lobby.players.length > 1 ? lobby.lobbyId : undefined,
    })),
  );

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

    await this.scheduleExpandedSearch(
      type,
      region,
      10000 + Math.floor(Math.random() * 10000),
    );
  }

  /**
   * Queues another pass over a region.
   *
   * A delayed job rather than a setTimeout: the jobId collapses duplicates, so
   * the several callers that can all want another pass at once do not stack up
   * timers, and a pending pass survives a restart instead of being lost.
   */
  private async scheduleExpandedSearch(
    type: e_match_types_enum,
    region: string,
    delay: number,
  ) {
    try {
      await this.queue.add(
        "ExpandMatchmaking",
        { type, region },
        {
          delay,
          jobId: `matchmaking.expand.${type}.${region}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      this.logger.error(
        `Unable to schedule another matchmaking pass for ${type}/${region}:`,
        error,
      );
    }
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
          const [players1, players2] = shuffleSplit(
            details.players.map((player) => ({
              ...player,
              lobby_id: details.lobbyId,
            })),
          );

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

  /**
   * Carves as many matches as possible out of the queue in one pass.
   *
   * Lobbies stay claimed between iterations: a lobby that misses one match is a
   * candidate for the next, and releasing it just to re-claim it would churn the
   * queue keys and push a redundant queue update to everyone in it.
   *
   * Returns the number of players left unmatched, which the caller uses to
   * decide whether another pass could help. 0 means "do not bother retrying".
   */
  private async createMatches(
    region: string,
    type: e_match_types_enum,
    lobbies: Array<MatchmakingLobby>,
  ): Promise<number> {
    const requiredPlayers = ExpectedPlayers[type];

    // lobbies we hold the lock for and have not committed to a match
    const claimed = new Map<string, MatchmakingLobby>();
    // lobbies we have not tried to claim yet
    const untried = new Map<string, MatchmakingLobby>(
      lobbies.map((lobby) => [lobby.lobbyId, lobby]),
    );

    const countPlayers = (pool: Array<MatchmakingLobby>) =>
      pool.reduce((acc, lobby) => acc + lobby.players.length, 0);

    try {
      for (;;) {
        const pool = [...claimed.values(), ...untried.values()];
        const remainingPlayers = countPlayers(pool);

        if (remainingPlayers < requiredPlayers) {
          return remainingPlayers;
        }

        // parties are atomic, so a pool can hold enough players and still have
        // no legal split - five duos can never make two teams of five. that
        // cannot resolve on its own, so report 0 rather than spinning the retry.
        if (
          !canFillTeams(
            pool.map((lobby) => lobby.players.length),
            requiredPlayers,
          )
        ) {
          this.logger.warn(
            `${type}/${region}: ${remainingPlayers} queued but the party sizes cannot fill two lineups`,
          );
          return 0;
        }

        const selection = selectMatchCandidates(pool, requiredPlayers);

        if (!selection) {
          return remainingPlayers;
        }

        // top up the claimed pool in preference order. selectMatchCandidates
        // returns every lobby rather than just the window, so lobbies that fail
        // to claim are replaced from the tail.
        for (const lobby of selection.candidates) {
          if (claimed.size >= WINDOW_CAP) {
            break;
          }

          if (claimed.has(lobby.lobbyId)) {
            continue;
          }

          let acquired = false;
          try {
            acquired = await this.claimLobby(lobby.lobbyId, lobby);
          } catch (error) {
            this.logger.error(`Error claiming lobby ${lobby.lobbyId}:`, error);
            untried.delete(lobby.lobbyId);
            continue;
          }

          untried.delete(lobby.lobbyId);

          if (!acquired) {
            // another region is matchmaking it - we never owned it, so it must
            // not be requeued here
            this.logger.warn(
              `Unable to acquire lobby lock for ${lobby.lobbyId} - lobby is already being processed`,
            );
            continue;
          }

          claimed.set(lobby.lobbyId, lobby);
        }

        // pure from here until the confirmation, so the teams we pick are
        // guaranteed to still be ours
        const claimedPool = [...claimed.values()];
        const balanced =
          balanceTeams(claimedPool, requiredPlayers) ??
          // the anchor itself may be what makes the split impossible
          balanceTeams(claimedPool, requiredPlayers, { pinAnchor: false });

        if (!balanced) {
          this.logger.warn(
            `${type}/${region}: no valid split among ${claimed.size} claimed lobbies`,
          );
          return remainingPlayers;
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

        const matched = [...balanced.team1, ...balanced.team2];
        const team1 = toMatchmakingTeam(balanced.team1);
        const team2 = toMatchmakingTeam(balanced.team2);

        // the confirmation re-ttls these locks and owns them from here
        for (const lobby of matched) {
          claimed.delete(lobby.lobbyId);
        }

        try {
          await this.createMatchConfirmation(region, type, { team1, team2 });
        } catch (error) {
          this.logger.error(`Error creating match confirmation:`, error);
          // ownership comes back to us, so the settle path requeues them
          for (const lobby of matched) {
            claimed.set(lobby.lobbyId, lobby);
          }
          return remainingPlayers;
        }
      }
    } finally {
      // single settle path - every lobby we still hold is requeued exactly
      // once, even if the loop threw
      for (const lobbyId of claimed.keys()) {
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
    team1: { steam_id: string; rank: number; lobby_id?: string }[];
    team2: { steam_id: string; rank: number; lobby_id?: string }[];
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
      await this.scheduleExpandedSearch(
        type,
        region,
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
            party_id: player.lobby_id ?? null,
            party_source: player.lobby_id ? "lobby" : null,
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
            party_id: player.lobby_id ?? null,
            party_source: player.lobby_id ? "lobby" : null,
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
