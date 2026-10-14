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
import { CacheService } from "../cache/cache.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { NotificationsService } from "src/notifications/notifications.service";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingRankCacheKey,
  getMatchmakingStrandedCacheKey,
} from "./utilities/cacheKeys";
import { QueuedLobbyStat } from "./types/QueuedLobbyStat";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";
import { shuffleSplit } from "./utilities/shuffleSplit";
import { balanceTeams, canFillTeams } from "./utilities/balanceTeams";
import { selectMatchCandidates } from "./utilities/selectMatchCandidates";
import { WINDOW_CAP, winProbability } from "./utilities/matchmakingTuning";

type MatchmakePass = { claimed: boolean; unchecked?: boolean };

type NextPass = { delay: number; failures: number };

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
    private readonly notifications: NotificationsService,
    @InjectQueue(MatchmakingQueues.Matchmaking) private queue: Queue,
    private readonly cache: CacheService,
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

    const regionStats: Partial<
      Record<string, Partial<Record<e_match_types_enum, QueuedLobbyStat[]>>>
    > = {};

    const regionValues = regions.server_regions.map(
      (region: { value: string }) => region.value,
    );

    for (const type of MatchmakingLobbyService.QUEUE_TYPES) {
      // A lobby queued in several regions keeps one index across all of them,
      // so the client can count it once.
      const lobbyIndexes = new Map<string, number>();
      const lobbySizes = new Map<string, number>();

      for (const region of regions.server_regions) {
        const lobbyIds = await this.redis.zrange(
          getMatchmakingQueueCacheKey(type, region.value),
          0,
          -1,
        );

        const queued: QueuedLobbyStat[] = [];

        for (const lobbyId of lobbyIds) {
          let index = lobbyIndexes.get(lobbyId);

          if (index === undefined) {
            const details =
              await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

            if (!details) {
              await this.dropStrayQueueEntries(lobbyId, type, regionValues);
              continue;
            }

            index = lobbyIndexes.size;
            lobbyIndexes.set(lobbyId, index);
            lobbySizes.set(lobbyId, details.players.length);
          }

          queued.push({ lobby: index, players: lobbySizes.get(lobbyId) });
        }

        const stats = (regionStats[region.value] ??= {});
        stats[type] = queued;
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

  /**
   * Resolves to the pass it queued to follow this one, if any. `failures`
   * counts the passes in a row that could not check who is busy.
   */
  public async matchmake(
    type: e_match_types_enum,
    region: string,
    failures = 0,
  ): Promise<NextPass | undefined> {
    const lockToken = await this.aquireMatchmakeRegionLock(type, region);
    if (!lockToken) {
      this.logger.warn(
        `Unable to acquire region lock for ${type}/${region} - another matchmaking process is running`,
      );
      // the pass that holds it may have read the queue before this one was
      // asked for
      return await this.scheduleExpandedSearch(
        type,
        region,
        1000 + Math.floor(Math.random() * 4000),
        failures,
      );
    }

    const pass: MatchmakePass = { claimed: false };

    try {
      let lobbies: MatchmakingLobby[] = [];
      let totalPlayerNotQueued = 0;

      try {
        // TODO - its possible, but highly unlikley we will ever runinto the issue of too many lobbies in the queue
        const lobbiesData = await this.redis.zrange(
          getMatchmakingRankCacheKey(type, region),
          0,
          -1,
          "WITHSCORES",
        );

        lobbies = await this.processLobbyData(lobbiesData, type, region, pass);

        if (lobbies.length > 0) {
          totalPlayerNotQueued = await this.createMatches(
            region,
            type,
            lobbies,
            pass,
          );
        }
      } finally {
        await this.releaseMatchmakeRegionLock(type, region, lockToken);
      }

      if (lobbies.length === 0) {
        if (pass.unchecked) {
          return await this.scheduleExpandedSearch(
            type,
            region,
            Math.min(
              MatchmakeService.UNCHECKED_RETRY_MS * 2 ** failures,
              MatchmakeService.UNCHECKED_RETRY_CAP_MS,
            ),
            failures + 1,
          );
        }

        return;
      }

      if (totalPlayerNotQueued < ExpectedPlayers[type]) {
        return;
      }

      this.logger.log(
        `${totalPlayerNotQueued} players not queued, expanding search....`,
      );

      return await this.scheduleExpandedSearch(
        type,
        region,
        10000 + Math.floor(Math.random() * 10000),
      );
    } finally {
      // A claim takes a lobby out of every region's queue, so any broadcast
      // made while this pass held one (another region's, a join's) missed it.
      if (pass.claimed) {
        await this.refreshRegionStats();
      }
    }
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
    failures = 0,
  ): Promise<NextPass> {
    try {
      await this.queue.add(
        "ExpandMatchmaking",
        { type, region, failures },
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

    return { delay, failures };
  }

  private static readonly UNCHECKED_RETRY_MS = 10 * 1000;
  private static readonly UNCHECKED_RETRY_CAP_MS = 5 * 60 * 1000;

  private async processLobbyData(
    lobbiesData: string[],
    type: e_match_types_enum,
    region: string,
    pass: MatchmakePass = { claimed: false },
  ): Promise<MatchmakingLobby[]> {
    const queued: MatchmakingLobby[] = [];

    for (let i = 0; i < lobbiesData.length; i += 2) {
      const details = await this.matchmakingLobbyService.getLobbyDetails(
        lobbiesData[i],
      );

      if (
        !details ||
        details.type !== type ||
        !details.regions.includes(region)
      ) {
        if (await this.dropStrayQueueEntries(lobbiesData[i], type, [region])) {
          pass.claimed = true;
        }
        continue;
      }

      // However it got back in the queue, a lobby in a ready check, or in the
      // match that came out of one, must not be claimed into another.
      if (await this.hasCurrentConfirmation(details.lobbyId)) {
        await this.matchmakingLobbyService.dequeueLobby(details.lobbyId);
        pass.claimed = true;
        continue;
      }

      queued.push(details);
    }

    let busy: Map<string, string>;
    try {
      busy = await this.getBusyPlayers(
        queued.flatMap((lobby) =>
          lobby.players.map((player) => player.steam_id),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Unable to check who is already in a match for ${type}/${region}:`,
        error,
      );
      pass.unchecked = true;
      return [];
    }

    const lobbyDetails = [];
    // A player who joined a party is still in their solo entry until the
    // lobby_players event removes it.
    const seated = new Set<string>();

    for (const details of queued) {
      if (details.players.some((player) => busy.has(player.steam_id))) {
        await this.dropLobbyWithBusyPlayers(details, busy);
        pass.claimed = true;
        continue;
      }

      if (details.players.some((player) => seated.has(player.steam_id))) {
        continue;
      }

      for (const player of details.players) {
        seated.add(player.steam_id);
      }

      if (details.players.length === ExpectedPlayers[details.type]) {
        const lock = await this.claimLobby(details.lobbyId, details);
        if (!lock) {
          this.logger.warn(
            `Unable to acquire lobby lock for ${details.lobbyId} - lobby is already being processed`,
          );
          continue;
        }

        pass.claimed = true;

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

          await this.createMatchConfirmation(region, details.type, {
            team1,
            team2,
          });
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
    pass: MatchmakePass = { claimed: false },
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
          pass.claimed = true;
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

  private async refreshRegionStats() {
    try {
      await this.sendRegionStats();
    } catch (error) {
      this.logger.warn("unable to send region stats", error);
    }
  }

  // Per type as well as region: queue entries never span types, so passes of
  // different types have nothing to serialise on.
  private async aquireMatchmakeRegionLock(
    type: e_match_types_enum,
    region: string,
  ): Promise<string | null> {
    return await this.cache.acquireLock(
      this.getRegionLockKey(type, region),
      60,
    );
  }

  private async releaseMatchmakeRegionLock(
    type: e_match_types_enum,
    region: string,
    lockToken: string,
  ) {
    await this.cache.releaseLock(
      this.getRegionLockKey(type, region),
      lockToken,
    );
  }

  private getRegionLockKey(type: e_match_types_enum, region: string) {
    return `matchmaking:lock:${region}:${type}`;
  }

  private getLobbyLockKey(lobbyId: string) {
    return `matchmaking:lock:${lobbyId}`;
  }

  // KEYS: the lobby's details, then a queue and rank key for each region in
  // ARGV[3..]. An entry is the lobby's only where its details name that type
  // and region. The details are read inside the script, so an entry that was
  // stray when the caller looked and has since been queued for real is kept.
  private static readonly DROP_STRAY_ENTRIES_SCRIPT = `
    local queuedIn = {}
    local details = redis.call('HGET', KEYS[1], 'details')
    if details then
      local lobby = cjson.decode(details)
      if lobby.type == ARGV[2] then
        for _, region in ipairs(lobby.regions) do
          queuedIn[region] = true
        end
      end
    end
    local dropped = 0
    for i = 3, #ARGV do
      if not queuedIn[ARGV[i]] then
        local queue = 2 * (i - 2)
        dropped = dropped + redis.call('ZREM', KEYS[queue], ARGV[1])
        dropped = dropped + redis.call('ZREM', KEYS[queue + 1], ARGV[1])
      end
    end
    return dropped
  `;

  // A queue entry can outlive what it was queued for: addLobbyToQueue reads
  // the details and then zadds, so a leave, or a leave and a join for another
  // type, landing in between leaves an entry behind. Nothing expires the
  // sorted sets, so it would sit in the queue - and in the queue counts -
  // forever, and a pass would match the lobby for a type or region it is not
  // queued for.
  private async dropStrayQueueEntries(
    lobbyId: string,
    type: e_match_types_enum,
    regions: string[],
  ) {
    const keys = [getMatchmakingLobbyDetailsCacheKey(lobbyId)];

    for (const region of regions) {
      keys.push(getMatchmakingQueueCacheKey(type, region));
      keys.push(getMatchmakingRankCacheKey(type, region));
    }

    const dropped = Number(
      await this.redis.eval(
        MatchmakeService.DROP_STRAY_ENTRIES_SCRIPT,
        keys.length,
        ...keys,
        lobbyId,
        type,
        ...regions,
      ),
    );

    if (dropped > 0) {
      this.logger.warn(
        `removed stray ${type} queue entry for lobby ${lobbyId}`,
      );
    }

    return dropped > 0;
  }

  // A lobby that left after the pass read it is no longer in any of its
  // queues, and must not be claimed into a ready check it would never see.
  // One that left and queued again is not the lobby the pass matched either,
  // whatever entry the old one left behind: joinedAt is set by the join, so it
  // tells the two apart.
  private static readonly CLAIM_LOBBY_SCRIPT = `
    local details = redis.call('HGET', KEYS[2], 'details')
    if not details or cjson.decode(details).joinedAt ~= ARGV[3] then
      return 0
    end
    local queued = false
    for i = 3, #KEYS do
      if redis.call('ZSCORE', KEYS[i], ARGV[1]) then
        queued = true
      end
    end
    if not queued then
      return 0
    end
    local acquired = redis.call('SET', KEYS[1], 1, 'EX', ARGV[2], 'NX')
    if not acquired then
      return 0
    end
    for i = 3, #KEYS do
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

    const keys: string[] = [
      this.getLobbyLockKey(lobbyId),
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
    ];

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
      new Date(lobby.joinedAt).toISOString(),
    );

    return result === 1;
  }

  private async releaseLobbyAndRequeue(lobbyId: string): Promise<void> {
    await this.releaseLobbyLock(lobbyId, 0);
    await this.addLobbyToQueue(lobbyId);
  }

  // A stamp can outlive its ready check when the lobby left first, so it only
  // counts while the confirmation it names still exists.
  public async hasCurrentConfirmation(lobbyId: string) {
    const confirmationId = await this.redis.hget(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      "confirmationId",
    );

    if (!confirmationId) {
      return false;
    }

    return !!(await this.redis.hget(
      getMatchmakingConformationCacheKey(confirmationId),
      "lobbyIds",
    ));
  }

  // is_in_another_match is checked once, when a lobby joins. A tournament or
  // league match can go live, or come within the hour, while its players wait
  // in the queue or in a ready check.
  private async getBusyPlayers(steamIds: string[]) {
    const busy = new Map<string, string>();

    if (steamIds.length === 0) {
      return busy;
    }

    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            steam_id: { _in: steamIds },
            is_in_another_match: { _eq: true },
          },
        },
        steam_id: true,
        name: true,
      },
    });

    for (const player of players) {
      busy.set(player.steam_id, player.name);
    }

    return busy;
  }

  private async dropLobbyWithBusyPlayers(
    lobby: MatchmakingLobby,
    busy: Map<string, string>,
  ) {
    const name = this.busyPlayerName(lobby, busy);

    this.logger.warn(
      `Dropping lobby ${lobby.lobbyId} from the queue: ${name} is already in a match`,
    );

    await this.releaseLobbyLock(lobby.lobbyId, 0);
    await this.matchmakingLobbyService.dequeueLobby(lobby.lobbyId);
    await this.matchmakingLobbyService.removeLobbyDetails(lobby.lobbyId);

    await this.sendPlayerInMatch(lobby, name);
  }

  private async sendPlayerInMatch(lobby: MatchmakingLobby, name: string) {
    for (const player of lobby.players) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: player.steam_id,
          event: "matchmaking:error",
          data: {
            code: "player_in_match",
            name,
            message: `${name} is already in a match`,
          },
        }),
      );
    }
  }

  private busyPlayerName(lobby: MatchmakingLobby, busy: Map<string, string>) {
    return lobby.players
      .map((player) => busy.get(player.steam_id))
      .find((playerName) => playerName !== undefined);
  }

  public async releaseLobbyLock(lobbyId: string, seconds: number) {
    await this.redis.expire(this.getLobbyLockKey(lobbyId), seconds);
  }

  private static readonly STRANDED_SIGHTING_TTL_MS = 5 * 60 * 1000;
  private static readonly STRANDED_MIN_AGE_MS = 30 * 1000;

  // KEYS: the lobby's details, the last sweep's sighting of it, its stamp's
  // confirmation and the claim on creating that confirmation's match, ARGV[5]
  // locks, then a queue and rank key per region.
  //
  // A leave, a join and a cancel each pass through the stranded state on their
  // way, so one look proves nothing. The first look only records what it saw.
  // The lobby is acted on when a later look, STRANDED_MIN_AGE_MS on, finds the
  // same details and stamp still stranded, with no look in between that found
  // it otherwise.
  //
  // A ready check that is over can still be accepted while its hash lasts, so
  // a lobby whose ready check has a match, or a creation still running, is
  // not stranded either.
  private static readonly HEAL_STRANDED_LOBBY_SCRIPT = `
    local locks = tonumber(ARGV[5])

    local function stranded()
      local details = redis.call('HGET', KEYS[1], 'details') or ''
      local stamp = redis.call('HGET', KEYS[1], 'confirmationId') or ''
      if details ~= ARGV[2] or stamp ~= ARGV[3] then
        return false
      end
      if redis.call('HEXISTS', KEYS[3], 'matchId') == 1 then
        return false
      end
      if redis.call('PTTL', KEYS[4]) > tonumber(ARGV[9]) then
        return false
      end
      for i = 5, 4 + locks do
        if redis.call('EXISTS', KEYS[i]) == 1 then
          return false
        end
      end
      for i = 5 + locks, #KEYS do
        if redis.call('ZSCORE', KEYS[i], ARGV[1]) then
          return false
        end
      end
      return true
    end

    if not stranded() then
      redis.call('DEL', KEYS[2])
      return 0
    end

    local sighting = redis.sha1hex(ARGV[2] .. '|' .. ARGV[3])
    if redis.call('GET', KEYS[2]) ~= sighting then
      redis.call('SET', KEYS[2], sighting, 'PX', ARGV[7])
      return 0
    end
    if redis.call('PTTL', KEYS[2]) > tonumber(ARGV[7]) - tonumber(ARGV[8]) then
      return 0
    end

    if ARGV[4] == 'check' then
      return 1
    end
    redis.call('DEL', KEYS[2])
    redis.call('HDEL', KEYS[1], 'confirmationId')
    if ARGV[4] == 'requeue' then
      for i = 5 + locks, #KEYS, 2 do
        redis.call('ZADD', KEYS[i], 0, ARGV[1])
        redis.call('ZADD', KEYS[i + 1], ARGV[6], ARGV[1])
      end
      return 1
    end
    redis.call('HDEL', KEYS[1], 'details')
    return 1
  `;

  // A lobby keeps its details from the join until it leaves or its match
  // ends, and all that time it is in its queues, in a ready check or the match
  // it made, or under the lock of whatever is moving it. A pod that dies
  // mid-pass, or a ready check that nothing cancels, leaves it in none of
  // those, and every rejoin is refused until the player clicks Leave.
  public async healStrandedLobbies() {
    const prefix = getMatchmakingLobbyDetailsCacheKey("");
    let cursor = "0";
    let healed = false;

    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        1000,
      );
      cursor = next;

      for (const key of keys) {
        const lobbyId = key.slice(prefix.length);
        try {
          if (await this.healStrandedLobby(lobbyId)) {
            healed = true;
          }
        } catch (error) {
          this.logger.error(
            `unable to heal matchmaking lobby ${lobbyId}`,
            error,
          );
        }
      }
    } while (cursor !== "0");

    if (healed) {
      await this.refreshRegionStats();
    }
  }

  private async healStrandedLobby(lobbyId: string): Promise<boolean> {
    const { details = "", confirmationId = "" } = await this.redis.hgetall(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
    );

    if (!details && !confirmationId) {
      return false;
    }

    const sighting = getMatchmakingStrandedCacheKey(lobbyId);

    if (confirmationId && !(await this.isReadyCheckOver(confirmationId))) {
      await this.redis.del(sighting);
      return false;
    }

    const lobby: MatchmakingLobby | undefined = details
      ? JSON.parse(details)
      : undefined;
    const regions = lobby?.regions ?? [];

    const locks = [
      this.getLobbyLockKey(lobbyId),
      ...regions.map((region) => this.getRegionLockKey(lobby.type, region)),
    ];
    const keys = [
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      sighting,
      getMatchmakingConformationCacheKey(confirmationId),
      this.getMatchCreationClaimKey(confirmationId),
      ...locks,
      ...regions.flatMap((region) => [
        getMatchmakingQueueCacheKey(lobby.type, region),
        getMatchmakingRankCacheKey(lobby.type, region),
      ]),
    ];

    const heal = async (action: "check" | "requeue" | "clear") =>
      (await this.redis.eval(
        MatchmakeService.HEAL_STRANDED_LOBBY_SCRIPT,
        keys.length,
        ...keys,
        lobbyId,
        details,
        confirmationId,
        action,
        locks.length,
        lobby?.avgRank ?? 0,
        MatchmakeService.STRANDED_SIGHTING_TTL_MS,
        MatchmakeService.STRANDED_MIN_AGE_MS,
        MatchmakeService.CREATION_RUNNING_TTL_MS,
      )) === 1;

    if (!(await heal("check"))) {
      return false;
    }

    // Nobody can say who accepted a ready check that is over, so, as a cancel
    // does with a lobby that was not all ready, its lobbies leave the queue.
    let requeue =
      !confirmationId && regions.length > 0 && Number.isFinite(lobby.avgRank);

    let busy = new Map<string, string>();
    if (requeue) {
      busy = await this.getBusyPlayers(
        lobby.players.map((player) => player.steam_id),
      );
      requeue = busy.size === 0 && (await this.canRequeue(lobby));
    }

    if (!(await heal(requeue ? "requeue" : "clear"))) {
      return false;
    }

    if (requeue) {
      this.logger.warn(`requeued stranded matchmaking lobby ${lobbyId}`);
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
      for (const region of lobby.regions) {
        await this.scheduleExpandedSearch(
          lobby.type,
          region,
          Math.floor(Math.random() * 10000),
        );
      }
      return true;
    }

    this.logger.warn(`dropped stranded matchmaking lobby ${lobbyId}`);

    // its lobbies are free to queue again, so it must not become a match
    if (confirmationId) {
      await this.removeConfirmationDetails(confirmationId);
    }

    if (lobby) {
      if (busy.size > 0) {
        await this.sendPlayerInMatch(lobby, this.busyPlayerName(lobby, busy));
      }
      await this.matchmakingLobbyService.sendRemovedFromQueue(lobby.players);
    }

    return true;
  }

  // Over, whether or not a cancel ever ran: the cancel job leaves a ready
  // check to a creation that is running, which may never finish, and a pass
  // can die before queueing it.
  private async isReadyCheckOver(confirmationId: string) {
    const [lobbyIds, matchId, expiresAt] = await this.redis.hmget(
      getMatchmakingConformationCacheKey(confirmationId),
      "lobbyIds",
      "matchId",
      "expiresAt",
    );

    if (matchId) {
      return false;
    }

    if (!lobbyIds) {
      return true;
    }

    return (
      Date.now() >
      new Date(expiresAt).getTime() + MatchmakeService.CANCEL_RETRY_BUDGET_MS
    );
  }

  // What a join checks, as far as it can without the captain who joined.
  private async canRequeue(lobby: MatchmakingLobby) {
    const steamIds = lobby.players.map((player) => player.steam_id);
    const current = await this.matchmakingLobbyService.getPlayerLobby(
      steamIds[0],
    );

    return (
      current.id === lobby.lobbyId &&
      current.players.length === steamIds.length &&
      current.players.every(
        (player) =>
          steamIds.includes(player.steam_id) &&
          !player.is_banned &&
          !player.matchmaking_cooldown,
      )
    );
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

    // Only this call can stamp these lobbies while it holds their locks.
    const stamped: string[] = [];

    try {
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
        stamped.push(lobbyId);
        await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
      }

      void this.notifications
        .notifyMatchFound(
          confirmationId,
          [...team1.players, ...team2.players].map(({ steam_id }) => steam_id),
          type,
          30,
        )
        .catch((error) => {
          this.logger.warn(
            `unable to push match found for confirmation ${confirmationId}`,
            error,
          );
        });

      await this.cancelMatchMakingDueToReadyCheck(confirmationId);
    } catch (error) {
      try {
        for (const lobbyId of stamped) {
          await this.matchmakingLobbyService.removeConfirmationIdFromLobby(
            lobbyId,
          );
        }
        await this.removeConfirmationDetails(confirmationId);
      } catch (cleanupError) {
        this.logger.error(
          `Unable to clean up confirmation ${confirmationId}:`,
          cleanupError,
        );
      }

      throw error;
    }
  }

  private static readonly CANCEL_ATTEMPTS = 5;
  private static readonly CANCEL_BACKOFF_MS = 5000;

  // The waits between the cancel job's attempts, and as long again for the
  // attempts themselves.
  private static readonly CANCEL_RETRY_BUDGET_MS =
    2 *
    MatchmakeService.CANCEL_BACKOFF_MS *
    (2 ** (MatchmakeService.CANCEL_ATTEMPTS - 1) - 1);

  public async cancelMatchMakingDueToReadyCheck(confirmationId: string) {
    await this.queue.add(
      "CancelMatchMaking",
      {
        confirmationId,
      },
      {
        delay: 30 * 1000,
        jobId: this.getMatchMakingCancelJobId(confirmationId),
        attempts: MatchmakeService.CANCEL_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: MatchmakeService.CANCEL_BACKOFF_MS,
        },
      },
    );
  }

  private async removeCancelMatchMakingJob(confirmationId: string) {
    await this.queue.remove(this.getMatchMakingCancelJobId(confirmationId));
  }

  private getMatchMakingCancelJobId(confirmationId: string) {
    return `matchmaking.cancel.${confirmationId}`;
  }

  // Outlives the cancel job and all of its retries. A ready check that becomes
  // a match is kept for as long as the match is, see createMatch.
  private static readonly READY_CHECK_TTL_SECONDS = 10 * 60;

  // The claim on creating a match is taken with the ready check's ttl, by a
  // creation or by a cancel. While it has more than this left it is younger
  // than the cancel job's retry budget and whichever took it may still be
  // running. Past that it failed, and the claim only stops a second match.
  private static readonly CREATION_RUNNING_TTL_MS =
    MatchmakeService.READY_CHECK_TTL_SECONDS * 1000 -
    MatchmakeService.CANCEL_RETRY_BUDGET_MS;

  private static readonly CREATING_MATCH = "creating";
  private static readonly CANCELLING_MATCH = "cancelling";

  // KEYS: the ready check, then the claim on creating its match.
  //
  // The cancel job fires on a timer, so a creation can be running when it
  // does: it takes the claim a creation would, and whichever has it settles
  // the ready check. A creation that gives up hands its claim over, and a
  // cancel keeps its own, so the job's retries can finish what either could
  // not.
  private static readonly CLAIM_CANCEL_SCRIPT = `
    if redis.call('HEXISTS', KEYS[1], 'matchId') == 1 then
      return 0
    end
    local claim = redis.call('GET', KEYS[2])
    if claim == ARGV[1] then
      return 0
    end
    if not claim then
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
    end
    return 1
  `;

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

    await this.redis.expire(
      getMatchmakingConformationCacheKey(confirmationId),
      MatchmakeService.READY_CHECK_TTL_SECONDS,
    );
  }

  public async removeConfirmationDetails(confirmationId: string) {
    this.retractMatchFound(confirmationId);

    const confirmedKey = `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`;
    await this.redis.del(confirmedKey);

    await this.redis.del(this.getMatchCreationClaimKey(confirmationId));

    await this.redis.del(getMatchmakingConformationCacheKey(confirmationId));
  }

  private retractMatchFound(confirmationId: string, steamId?: string) {
    void this.notifications
      .retractMatchFound(confirmationId, steamId)
      .catch((error) => {
        this.logger.warn(
          `unable to retract match found for confirmation ${confirmationId}`,
          error,
        );
      });
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
    if (!hasMatch && !(await this.claimReadyCheckForCancel(confirmationId))) {
      return;
    }

    let shouldMatchmake = false;
    const { lobbyIds, type, region } =
      await this.getMatchConfirmationDetails(confirmationId);

    for (const lobbyId of lobbyIds) {
      // A lobby that left this ready check and queued again belongs to
      // whatever it is in now, a newer ready check included.
      const stamp = await this.redis.hget(
        getMatchmakingLobbyDetailsCacheKey(lobbyId),
        "confirmationId",
      );

      if (stamp !== confirmationId) {
        continue;
      }

      const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

      if (!lobby) {
        await this.matchmakingLobbyService.removeConfirmationIdFromLobby(
          lobbyId,
        );
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

      await this.matchmakingLobbyService.dequeueLobby(lobbyId);
      await this.matchmakingLobbyService.removeConfirmationIdFromLobby(lobbyId);

      if (!requeue) {
        await this.matchmakingLobbyService.removeLobbyDetails(lobbyId);
        continue;
      }

      shouldMatchmake = true;
      // the ready check's lock would otherwise hold it out of the next pass
      await this.releaseLobbyLock(lobbyId, 0);
      await this.addLobbyToQueue(lobbyId);
    }

    await this.removeConfirmationDetails(confirmationId);

    await this.refreshRegionStats();

    if (shouldMatchmake) {
      await this.scheduleExpandedSearch(
        type,
        region,
        Math.floor(Math.random() * 10000),
      );
    }
  }

  private async claimReadyCheckForCancel(confirmationId: string) {
    return (
      (await this.redis.eval(
        MatchmakeService.CLAIM_CANCEL_SCRIPT,
        2,
        getMatchmakingConformationCacheKey(confirmationId),
        this.getMatchCreationClaimKey(confirmationId),
        MatchmakeService.CREATING_MATCH,
        MatchmakeService.CANCELLING_MATCH,
        MatchmakeService.READY_CHECK_TTL_SECONDS,
      )) === 1
    );
  }

  private async handCreationToCancel(confirmationId: string) {
    await this.redis.set(
      this.getMatchCreationClaimKey(confirmationId),
      MatchmakeService.CANCELLING_MATCH,
      "KEEPTTL",
      "XX",
    );
  }

  public async playerConfirmMatchmaking(
    confirmationId: string,
    steamId: string,
  ) {
    const { lobbyIds, team1, team2, matchId } =
      await this.getMatchConfirmationDetails(confirmationId);

    if (matchId) {
      return;
    }

    // An expired confirmation reads back as empty teams, so this also stops a
    // late confirmation from creating a match with nobody in it.
    const isPlaying = [...team1, ...team2].some(
      (player) => player.steam_id === steamId,
    );

    if (!isPlaying) {
      return;
    }

    await this.redis.hset(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
      steamId,
      1,
    );
    await this.redis.expire(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
      MatchmakeService.READY_CHECK_TTL_SECONDS,
    );

    this.retractMatchFound(confirmationId, steamId);

    const { confirmed } =
      await this.getMatchConfirmationDetails(confirmationId);

    if (confirmed.length != team1.length + team2.length) {
      for (const lobbyId of lobbyIds) {
        void this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
      }
      return;
    }

    // Everyone is ready, but so is every other confirmation that arrived at the
    // same time. Whoever claims this key creates the match; the rest return.
    // The claim lives as long as the ready check and is dropped with it, so a
    // creation that fails hands it to the cancel, which puts every lobby back,
    // rather than leaving it to a second match.
    const claimedCreation = await this.redis.set(
      this.getMatchCreationClaimKey(confirmationId),
      MatchmakeService.CREATING_MATCH,
      "EX",
      MatchmakeService.READY_CHECK_TTL_SECONDS,
      "NX",
    );

    if (!claimedCreation) {
      return;
    }

    await this.createMatch(confirmationId);
  }

  private getMatchCreationClaimKey(confirmationId: string) {
    return `${getMatchmakingConformationCacheKey(confirmationId)}:creating`;
  }

  private async createMatch(confirmationId: string) {
    const { team1, team2, type, region, lobbyIds } =
      await this.getMatchConfirmationDetails(confirmationId);

    const players = [...team1, ...team2];

    // cancelled or expired since the last confirmation came in
    if (players.length === 0) {
      return;
    }

    let matchId: string | undefined;

    try {
      const busy = await this.getBusyPlayers(
        players.map((player) => player.steam_id),
      );

      // The cancel job stays queued: if this abort fails part way the job
      // finishes it, and once the confirmation is gone the job only refreshes
      // the region stats.
      if (busy.size > 0) {
        await this.handCreationToCancel(confirmationId);

        for (const lobbyId of lobbyIds) {
          const lobby =
            await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

          if (lobby?.players.some((player) => busy.has(player.steam_id))) {
            await this.dropLobbyWithBusyPlayers(lobby, busy);
          }
        }

        // everyone left accepted, so the cancel puts them back in the queue
        await this.cancelMatchMaking(confirmationId);
        return;
      }

      for (const lobbyId of lobbyIds) {
        await this.matchmakingLobbyService.dequeueLobby(lobbyId);
      }

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
      matchId = match.id;

      await this.hasura.mutation({
        insert_match_lineup_players: {
          __args: {
            objects: [
              ...team1.map((player) => ({
                steam_id: player.steam_id,
                match_lineup_id: match.lineup_1_id,
              })),
              ...team2.map((player) => ({
                steam_id: player.steam_id,
                match_lineup_id: match.lineup_2_id,
              })),
            ],
          },
          __typename: true,
        },
      });

      await this.matchAssistant.updateMatchStatus(match.id, "Live");
    } catch (error) {
      this.logger.error(
        `unable to create the match for confirmation ${confirmationId}`,
        error,
      );
      await this.abandonMatchCreation(confirmationId, matchId);
      throw error;
    }

    // add match id to the confirmation details
    await this.redis.hset(
      getMatchmakingConformationCacheKey(confirmationId),
      "matchId",
      matchId,
    );

    // kept until the match ends and cancelMatchMakingByMatchId removes it
    await this.redis.persist(
      getMatchmakingConformationCacheKey(confirmationId),
    );
    await this.redis.persist(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
    );

    await this.redis.set(`matches:confirmation:${matchId}`, confirmationId);

    await this.removeCancelMatchMakingJob(confirmationId);

    for (const lobbyId of lobbyIds) {
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
    }
  }

  // Everyone accepted, so nobody is to blame for a match that could not be
  // made: the cancel puts every lobby back where it was in the queue.
  private async abandonMatchCreation(confirmationId: string, matchId?: string) {
    await this.handCreationToCancel(confirmationId);

    try {
      await this.cancelMatchMaking(confirmationId);
    } finally {
      if (matchId) {
        await this.hasura.mutation({
          delete_matches_by_pk: {
            __args: {
              id: matchId,
            },
            __typename: true,
          },
        });
      }
    }
  }
}
