import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { e_match_types_enum } from "generated";
import { validate as validateUUID } from "uuid";
import { PlayerLobby } from "./types/PlayerLobby";
import { MatchmakeService } from "./matchmake.service";
import { HasuraService } from "src/hasura/hasura.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { VerifyPlayerStatus } from "./types/VerifyPlayerStatus";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import {
  getMatchmakingRankCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
} from "./utilities/cacheKeys";

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

  public async getPlayerLobby(user: User): Promise<PlayerLobby> {
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

  public async verifyLobby(lobby: PlayerLobby) {
    for (const player of lobby.players) {
      const { players_by_pk } = await this.hasura.query({
        players_by_pk: {
          __args: {
            steam_id: player.steam_id,
          },
          is_banned: true,
          matchmaking_cooldown: true,
        },
      });
      if (
        !(await this.verifyPlayer({
          steam_id: player.steam_id,
          is_banned: players_by_pk.is_banned,
          matchmaking_cooldown: players_by_pk.matchmaking_cooldown,
        }))
      ) {
        this.logger.warn(`${player.steam_id} is not able to join the queue`);
        return false;
      }
    }

    return true;
  }

  public async setLobbyDetails(
    regions: Array<string>,
    type: e_match_types_enum,
    lobby: {
      id: string;
      players: Array<{
        steam_id: string;
        is_banned: boolean;
        matchmaking_cooldown: boolean;
      }>;
    },
  ) {
    await this.redis.hset(
      getMatchmakingLobbyDetailsCacheKey(lobby.id),
      "details",
      JSON.stringify({
        type,
        regions,
        joinedAt: new Date(),
        lobbyId: lobby.id,
        players: lobby.players.map(({ steam_id }) => steam_id),
        avgRank: await this.getAverageLobbyRank(lobby.players),
      }),
    );
  }

  public async removeLobbyDetails(lobbyId: string) {
    await this.redis.hdel(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      "details",
    );
    await this.redis.hdel(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      "confirmationId",
    );
  }

  public async setMatchConformationIdForLobby(
    lobbyId: string,
    confirmationId: string,
  ) {
    await this.redis.hset(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      "confirmationId",
      confirmationId,
    );
  }

  public async getAverageLobbyRank(players: Array<{ steam_id: string }>) {
    return 0;
  }

  public async getLobbyDetails(lobbyId: string): Promise<MatchmakingLobby> {
    const data = await this.redis.hget(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
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

    for (const region of queueDetails.regions) {
      await this.redis.zrem(
        getMatchmakingQueueCacheKey(queueDetails.type, region),
        lobbyId,
      );
      await this.redis.zrem(
        getMatchmakingRankCacheKey(queueDetails.type, region),
        lobbyId,
      );
    }

    await this.removeLobbyDetails(lobbyId);

    // notify players in the lobby that they have been removed from the queue
    for (const player of queueDetails.players) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: player,
          event: "matchmaking:details",
          data: {},
        }),
      );
    }

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
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      "confirmationId",
    );

    if (confirmationId) {
      const { matchId, confirmed, type, region, team1, team2, expiresAt } =
        await this.matchmaking.getMatchConfirmationDetails(confirmationId);

      confirmationDetails = {
        type,
        region,
        matchId,
        expiresAt,
        confirmationId,
        confirmed,
        players: team1.length + team2.length,
      };
    }

    const lobbyQueueDetails = await this.getLobbyDetails(lobbyId);

    if (!lobbyQueueDetails) {
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
              confirmed: confirmationDetails.confirmed.length,
              isReady:
                confirmationId &&
                confirmationDetails.confirmed.find((steamId) => {
                  return steamId === player;
                }),
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
