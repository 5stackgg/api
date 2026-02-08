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
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import {
  getMatchmakingRankCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
} from "./utilities/cacheKeys";
import { JoinQueueError } from "./utilities/joinQueueError";

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

  public async getPlayerLobby(steamId: string): Promise<PlayerLobby> {
    let lobbyId = await this.getCurrentLobbyId(steamId);

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
              name: true,
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
      lobbyId = steamId;
      const { players_by_pk } = await this.hasura.query({
        players_by_pk: {
          __args: {
            steam_id: steamId,
          },
          name: true,
          steam_id: true,
          is_banned: true,
          matchmaking_cooldown: true,
        },
      });

      return {
        id: lobbyId,
        players: [
          {
            captain: true,
            name: players_by_pk.name,
            steam_id: players_by_pk.steam_id,
            is_banned: players_by_pk.is_banned,
            matchmaking_cooldown: players_by_pk.matchmaking_cooldown,
          },
        ],
      };
    }

    return {
      id: lobbyId,
      players: lobby.players.map(({ steam_id, captain, player }) => {
        return {
          captain,
          name: player.name,
          steam_id: steam_id,
          is_banned: player.is_banned,
          matchmaking_cooldown: player.matchmaking_cooldown,
        };
      }),
    };
  }

  public async verifyLobby(
    lobby: PlayerLobby,
    user: User,
    type: e_match_types_enum,
  ) {
    const captain = lobby.players.find((player) => {
      return player.steam_id === user.steam_id && player.captain === true;
    });

    if (!captain) {
      throw new JoinQueueError(`you are not the captain of this lobby`);
    }

    const totalPlayers = lobby.players.length;

    switch (type) {
      case "Competitive":
        if (totalPlayers > 5 && totalPlayers !== 10) {
          throw new JoinQueueError(
            `To join a Competitive match, with a lobby greater than 5 players, you must have 10 players in your lobby`,
          );
        }
        break;
      case "Wingman":
        if (totalPlayers > 2 && totalPlayers !== 4) {
          throw new JoinQueueError(
            `To join a Wingman match, with a lobby greater than 2 players, you must have 4 players in your lobby`,
          );
        }
        break;
      case "Duel":
        if (totalPlayers > 1 && totalPlayers !== 2) {
          throw new JoinQueueError(
            `To join a Duel match, with a lobby greater than 1 player you must have 2 players in your lobby`,
          );
        }
        break;
    }

    for (const player of lobby.players) {
      await this.verifyPlayer(lobby.id, player.steam_id);
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
    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            steam_id: { _in: lobby.players.map((p) => p.steam_id) },
          },
        },
        steam_id: true,
        elo: true,
      },
    });

    const eloMap = new Map(players.map((p) => [p.steam_id, p.elo]));

    const _players = lobby.players.map(({ steam_id }) => {
      const playerElo = eloMap.get(steam_id);
      let elo = 5000;
      if (playerElo) {
        elo = Number(playerElo[type.toLowerCase()]);
      }
      return { steam_id, rank: elo };
    });

    const matchmakingLobby: MatchmakingLobby = {
      type,
      regions,
      joinedAt: new Date(),
      lobbyId: lobby.id,
      players: _players,
      avgRank:
        _players.reduce((acc, player) => acc + player.rank, 0) /
        _players.length,
      regionPositions: {},
    };

    await this.redis.hset(
      getMatchmakingLobbyDetailsCacheKey(lobby.id),
      "details",
      JSON.stringify(matchmakingLobby),
    );
  }

  public async removeLobbyDetails(lobbyId: string) {
    const lobbyDetails = await this.getLobbyDetails(lobbyId);

    if (!lobbyDetails) {
      return;
    }

    await this.redis.hdel(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      "details",
    );

    await this.removeConfirmationIdFromLobby(lobbyId);

    // notify players in the lobby that they have been removed from the queue
    for (const player of lobbyDetails.players) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: player.steam_id,
          event: "matchmaking:details",
          data: {},
        }),
      );
    }
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

  public async removeConfirmationIdFromLobby(lobbyId: string) {
    await this.redis.hdel(
      getMatchmakingLobbyDetailsCacheKey(lobbyId),
      "confirmationId",
    );
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
      return false;
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

    await this.matchmaking.sendRegionStats();

    return true;
  }

  // TODO - extermly inefficient
  public async sendQueueDetailsToPlayer(steamId: string) {
    const lobby = await this.getPlayerLobby(steamId);

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
      const {
        matchId,
        confirmed,
        type,
        region,
        team1,
        team2,
        expiresAt,
        lobbyIds,
      } = await this.matchmaking.getMatchConfirmationDetails(confirmationId);

      confirmationDetails = {
        type,
        region,
        matchId,
        expiresAt,
        confirmationId,
        confirmed,
        players: team1.length + team2.length,
      };

      if (matchId) {
        const { matches_by_pk: match } = await this.hasura.query({
          matches_by_pk: {
            __args: {
              id: matchId,
            },
            id: true,
            status: true,
          },
        });
        if (!match || match.status === "Canceled") {
          for (const lobby of lobbyIds) {
            await this.removeLobbyDetails(lobby);
          }
          await this.matchmaking.removeConfirmationDetails(confirmationId);

          for (const player of team1.concat(team2)) {
            await this.redis.publish(
              "send-message-to-steam-id",
              JSON.stringify({
                steamId: player,
                event: "matchmaking:details",
                data: {},
              }),
            );
          }
        }
      }
    }

    const lobbyQueueDetails = await this.getLobbyDetails(lobbyId);

    if (!lobbyQueueDetails) {
      return;
    }

    for (const player of lobbyQueueDetails.players) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: player.steam_id,
          event: "matchmaking:details",
          data: {
            details: await this.getLobbyDetails(lobbyId),
            confirmation: confirmationId && {
              ...confirmationDetails,
              confirmed: confirmationDetails.confirmed.length,
              isReady:
                confirmationId &&
                confirmationDetails.confirmed.find((steamId) => {
                  return steamId === player.steam_id;
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

  private async verifyPlayer(
    lobbyId: string,
    steamId: string,
  ): Promise<boolean> {
    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        name: true,
        steam_id: true,
        is_banned: true,
        matchmaking_cooldown: true,
        current_lobby_id: true,
        is_in_another_match: true,
      },
    });

    if (player.is_in_another_match) {
      throw new JoinQueueError(
        `${player.name} player is already in a match`,
        lobbyId,
      );
    }

    if (player.current_lobby_id && player.current_lobby_id !== lobbyId) {
      throw new JoinQueueError(
        `${player.name} player already in queue`,
        lobbyId,
      );
    }

    if (player.matchmaking_cooldown) {
      throw new JoinQueueError(
        `${player.name} is in matchmaking cooldown`,
        lobbyId,
      );
    }

    if (player.is_banned) {
      throw new JoinQueueError(`${player.name} is banned`, lobbyId);
    }

    return true;
  }
}
