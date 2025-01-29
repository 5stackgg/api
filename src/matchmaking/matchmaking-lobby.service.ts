import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { e_match_types_enum } from "generated";
import { validate as validateUUID } from "uuid";
import { HasuraService } from "src/hasura/hasura.service";
import { Logger } from "@nestjs/common";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingDetailsCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { MatchmakeService } from "./matchmake.service";
import { getMatchmakingConformationCacheKey } from "./utilities/cacheKeys";

type VerifyPlayerStatus = {
  steam_id: string;
  is_banned: boolean;
  matchmaking_cooldown: boolean;
};

type MatchmakingLobby = {
  id: string;
  players: Array<{
    steam_id: string;
    is_banned: boolean;
    matchmaking_cooldown: boolean;
  }>;
};

@Injectable()
export class MatchmakingLobbyService {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly redisManager: RedisManagerService,
    @Inject(forwardRef(() => MatchmakeService))
    private matchmaking: MatchmakeService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async getPlayerLobby(user: User): Promise<MatchmakingLobby> {
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

      return {
        id: lobbyId,
        players: [
          {
            steam_id: players_by_pk.steam_id,
            is_banned: players_by_pk.is_banned,
            matchmaking_cooldown: players_by_pk.matchmaking_cooldown,
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

    return {
      id: lobbyId,
      players: lobby.players.map(({ steam_id, player }) => {
        return {
          steam_id: steam_id,
          is_banned: player.is_banned,
          matchmaking_cooldown: player.matchmaking_cooldown,
        };
      }),
    };
  }

  public async verifyLobby(lobby: MatchmakingLobby) {
    for (const player of lobby.players) {
      if (
        !(await this.verifyPlayer({
          steam_id: player.steam_id,
          is_banned: player.is_banned,
          matchmaking_cooldown: player.matchmaking_cooldown,
        }))
      ) {
        this.logger.warn(`${player.steam_id} is not able to join the queue`);
        return false;
      }
    }

    return true;
  }

  public async setQueuedDetails(
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
      getMatchmakingDetailsCacheKey(lobbyId),
      "details",
      JSON.stringify(details),
    );
  }

  public async getLobbyDetails(lobbyId: string) {
    const data = await this.redis.hget(
      getMatchmakingDetailsCacheKey(lobbyId),
      "details",
    );

    if (!data) {
      return;
    }

    const details = JSON.parse(data);

    details.regionPositions = {};

    for (const region of details.regions) {
      const position = await this.redis.zrank(
        getMatchmakingQueueCacheKey(details.type, region),
        lobbyId,
      );

      details.regionPositions[region] = position + 1;
    }

    return details;
  }

  public async removeLobbyFromQueue(lobbyId: string) {
    const queueDetails = await this.getLobbyDetails(lobbyId);
    if (!queueDetails) {
      return;
    }

    const pipeline = this.redis.pipeline();

    for (const region of queueDetails.regions) {
      pipeline.zrem(
        getMatchmakingQueueCacheKey(queueDetails.type, region),
        lobbyId,
      );
      pipeline.zrem(
        getMatchmakingRankCacheKey(queueDetails.type, region),
        lobbyId,
      );
    }

    pipeline.del(getMatchmakingDetailsCacheKey(lobbyId));

    // notify players in the lobby that they have been removed from the queue
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
    await this.matchmaking.sendRegionStats();
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
      getMatchmakingDetailsCacheKey(lobbyId),
      "confirmationId",
    );

    if (confirmationId) {
      const { matchId, confirmed, type, region, players, expiresAt } =
        await this.matchmaking.getMatchConfirmationDetails(confirmationId);

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
                  getMatchmakingConformationCacheKey(confirmationId),
                  player,
                )),
            },
          },
        }),
      );
    }
  }

  public async setMatchConformationIdForLobby(
    lobbyId: string,
    confirmationId: string,
  ) {
    await this.redis.hset(
      getMatchmakingDetailsCacheKey(lobbyId),
      "confirmationId",
      confirmationId,
    );
  }

  public async sendQueueDetailsToAllUsers(
    type: e_match_types_enum,
    region: string,
  ) {
    const lobbies = await this.redis.zrange(
      getMatchmakingQueueCacheKey(type, region),
      0,
      -1,
    );

    for (const lobbyId of lobbies) {
      await this.sendQueueDetailsToLobby(lobbyId);
    }
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
    // TODO - use a redis SET to see if they are in the queue already
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
}
