import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { e_match_types_enum } from "generated";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { v4 as uuidv4, validate as validateUUID } from "uuid";
import { HasuraService } from "src/hasura/hasura.service";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";

type VerifyPlayerStatus = {
  steam_id: string;
  is_banned: boolean;
  matchmaking_cooldown: boolean;
};

@WebSocketGateway({
  path: "/ws/web",
})
export class MatchmakingGateway {
  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  // TODO - make a SET for each player that bleongs to a lobby

  protected static MATCH_MAKING_QUEUE_KEY(
    type: e_match_types_enum,
    region: string,
  ) {
    return `matchmaking:v1:${region}:${type}`;
  }

  protected static MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId: string) {
    return `matchmaking:v1:details:${lobbyId}`;
  }
  
  protected static MATCH_MAKING_CONFIRMATION_KEY(confirmationId: string) {
    return `matchmaking:v1:${confirmationId}`;
  }

  // TODO - send reason why they cant join the queue
  @SubscribeMessage("matchmaking:join-queue")
  async joinQueue(
    @MessageBody()
    data: {
      type: e_match_types_enum;
      regions: Array<string>;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await this.leaveQueue(client);
    
    const user = client.user;

    if (!user) {
      return;
    }

    const { type, regions } = data;

    if (!type || !regions || regions.length === 0) {
      return;
    }

    const lobby = await this.getPlayerLobby(user);

    if(!lobby) {
      return;
    }

    const joinedAt = new Date();

    await this.setQueuedDetails(
      lobby.id,
      { type, regions, joinedAt, lobbyId: lobby.id, players: lobby.players.map(({ steam_id }) => steam_id) },
    );

    /**
     * for each region add lobby into the queue
     */
    for (const region of regions) {
      // TODO - and speicic maps or map pool id
      await this.redis.zadd(
        MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
        joinedAt.getTime(),
        lobby.id,
      );
    }

    await this.sendQueueDetailsToLobby(lobby.id);
    await this.sendRegionStats();

    for (const region of regions) {
      this.matchmake(type, region);
    }
  }

  private async setQueuedDetails(
    lobbyId: string,
    details: {
      lobbyId: string;
      type: e_match_types_enum;
      regions: Array<string>;
      joinedAt: Date;
      players: Array<string>;
    },
  ) {
    await this.redis.hset(MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId), "details", JSON.stringify(details));
  }

  private async getLobbyDetails(lobbyId: string) {
    const data = await this.redis.hget(
      MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId),
      "details",
    );

    if (!data) {
      return;
    }

    const details = JSON.parse(data);

    details.regionPositions = {};

    for (const region of details.regions) {
      const position = await this.redis.zrank(
        MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(details.type, region),
        lobbyId,
      );

      details.regionPositions[region] = position + 1;
    }

    return details;
  }

  private async removeLobbyFromQueue(lobbyId: string) {
    const queueDetails = await this.getLobbyDetails(lobbyId);

    if(!queueDetails) {
      return;
    }

    for(const player of queueDetails.players) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: player,
          event: "matchmaking:details",
          data: {},
        }),
      );
    }

    const type = queueDetails.type;

    /**
     * remove player from each region they queued for
     */
    for (const region of queueDetails.regions) {
      await this.redis.zrem(
        MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
        lobbyId,
      );
      await this.sendQueueDetailsToAllUsers(type, region);
    }

    await this.sendRegionStats();

    await this.redis.del(
      MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId),
    );
  }

  @SubscribeMessage("matchmaking:leave")
  async leaveQueue(@ConnectedSocket() client: FiveStackWebSocketClient) {
    const user = client.user;

    if (!user) {
      return;
    }

    const lobby = await this.getPlayerLobby(user);

    if(!lobby) {
      return;
    }

    await this.removeLobbyFromQueue(lobby.id);
  }

  // TODO
  @SubscribeMessage("matchmaking:confirm")
  async playerConfirmation(
    @MessageBody()
    data: {
      confirmationId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    // const user = client.user;

    // if (!user) {
    //   return;
    // }

    // const { confirmationId } = data;

    // /**
    //  * if the user has already confirmed, do nothing
    //  */
    // if (
    //   await this.redis.hget(
    //     MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //     `${user.steam_id}`,
    //   )
    // ) {
    //   return;
    // }

    // /**
    //  * increment the number of players that have confirmed
    //  */
    // await this.redis.hincrby(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //   "confirmed",
    //   1,
    // );

    // /**
    //  * set the user as confirmed
    //  */
    // await this.redis.hset(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //   `${user.steam_id}`,
    //   1,
    // );

    // const { players, type, region, confirmed } =
    //   await this.getMatchConfirmationDetails(confirmationId);

    //   for(const player of players) {
    //     // this.sendQueueDetailsToLobby(player);
    //   }

    // if (confirmed != players.length) {
    //   return;
    // }

    // const match = await this.matchAssistant.createMatchBasedOnType(
    //   type as e_match_types_enum,
    //   // TODO - get map pool by type
    //   "Competitive",
    //   {
    //     mr: 12,
    //     best_of: 1,
    //     knife: true,
    //     overtime: true,
    //     timeout_setting: "Admin",
    //     region,
    //   },
    // );

    // await this.matchAssistant.removeCancelMatchMakingDueToReadyCheck(
    //   confirmationId,
    // );

    // const lineup1PlayersToInsert =
    //   type === "Wingman" ? players.slice(0, 2) : players.slice(0, 5);

    // await this.hasura.mutation({
    //   insert_match_lineup_players: {
    //     __args: {
    //       objects: lineup1PlayersToInsert.map((steamId: string) => ({
    //         steam_id: steamId,
    //         match_lineup_id: match.lineup_1_id,
    //       })),
    //     },
    //     __typename: true,
    //   },
    // });

    // const lineup2PlayersToInsert =
    //   type === "Wingman" ? players.slice(2) : players.slice(5);

    // await this.hasura.mutation({
    //   insert_match_lineup_players: {
    //     __args: {
    //       objects: lineup2PlayersToInsert.map((steamId: string) => ({
    //         steam_id: steamId,
    //         match_lineup_id: match.lineup_2_id,
    //       })),
    //     },
    //     __typename: true,
    //   },
    // });

    // /**
    //  * after the match is finished we need to remove people form the queue so they can queue again
    //  */
    // await this.redis.set(`matches:confirmation:${match.id}`, confirmationId);

    // /**
    //  * add match id to the confirmation details
    //  */
    // await this.redis.hset(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //   "matchId",
    //   match.id,
    // );

    // for (const steamId of players) {
    //   // this.sendQueueDetailsToLobby(lobbyId, steamId);
    // }

    // await this.matchAssistant.updateMatchStatus(match.id, "Veto");
  }

  public async getNumberOfPlayersInQueue(type: e_match_types_enum, region: string) {
    return await this.redis.zcard(
      MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
    );
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
        Competitive: await this.getNumberOfPlayersInQueue("Competitive", region.value),
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

    // TODO - extermly inefficient
    public async sendQueueDetailsToPlayer(user: User) {
    const lobby = await this.getPlayerLobby(user);

    if(!lobby) {
      return;
    }

    await this.sendQueueDetailsToLobby(lobby.id);
  }

  public async sendQueueDetailsToLobby(lobbyId: string) {
    let confirmationDetails;
    const confirmationId = await this.redis.hget(
      MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(lobbyId),
      "confirmationId",
    );
    
    if (confirmationId) {
      const { matchId, confirmed, type, region, players, expiresAt } =
        await this.getMatchConfirmationDetails(confirmationId);

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

    for(const player of lobbyQueueDetails.players) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: player,
          event: "matchmaking:details",
          data: {
            details: await this.getLobbyDetails(lobbyId),
            confirmation: confirmationId && {
              ...confirmationDetails,
              isReady: confirmationId && await this.redis.hget(
                MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
                player,
              )
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
      MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
      0,
      -1,
    );

    for (const lobbyId of lobbies) {
      await this.sendQueueDetailsToLobby(lobbyId);
    }
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
    console.info("CANCEL MATCH MAKING REODO")
    // const { players, type, region } =
    //   await this.getMatchConfirmationDetails(confirmationId);

    // for (const steamId of players) {
    //   if (readyCheckFailed) {
    //     const wasReady = await this.redis.hget(
    //       MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    //       steamId,
    //     );

    //     if (wasReady) {
    //       /**
    //        * if they wre ready, we want to requeue them into the queue
    //        */
    //       // I thin this was to remove the confirmation ID from the match?
    //       // await this.redis.hdel(
    //       //   MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(steamId),
    //       //   "confirmationId",
    //       // );

    //       const { regions, joinedAt } = await this.getLobbyDetails(steamId);
    //       for (const region of regions) {
    //         // TODO - re-add them to the queue
    //         // await this.redis.zadd(
    //         //   MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(type, region),
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
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
    // );

    // await this.sendRegionStats();

    // if (!readyCheckFailed) {
    //   return;
    // }

    // this.matchmake(type, region);
  }

  // TODO
  private async matchmake(
    type: e_match_types_enum,
    region: string,
    lock = true,
  ) {
    if (lock) {
      const lockKey = `matchmaking-lock:${type}:${region}`;
      const acquireLock = !!(await this.redis.set(lockKey, 1, "NX"));

      if (!acquireLock) {
        this.logger.warn("unable to acquire lock");
        return;
      }

      try {
        await this.matchmake(type, region, false);
        return;
      } finally {
        await this.redis.del(lockKey);
      }
    }

    const requiredPlayers = type === "Wingman" ? 4 : 10;

    const matchMakingQueueKey = MatchmakingGateway.MATCH_MAKING_QUEUE_KEY(
      type,
      region,
    );


    


  }

  private async confirmMatchMaking() {
    // const expiresAt = new Date();

    // expiresAt.setSeconds(expiresAt.getSeconds() + 30);

    // const confirmationId = uuidv4();
    
    // await this.redis.hset(
    //   MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
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
    //     MatchmakingGateway.MATCH_MAKING_DETAILS_QUEUE_KEY(steamId),
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

  private async getMatchConfirmationDetails(confirmationId: string) {
    const { type, region, steamIds, confirmed, matchId, expiresAt } =
      await this.redis.hgetall(
        MatchmakingGateway.MATCH_MAKING_CONFIRMATION_KEY(confirmationId),
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

  // TODO - seperate to get lobby in one and another to verify isntead of doing in 1 step
  private async getPlayerLobby(user: User): Promise<{
    id: string;
    players: Array<{
      steam_id: string;
    }>;
  }> {
    let lobbyId = await this.getCurrentLobbyId(user.steam_id);

    let lobby;
    if(validateUUID(lobbyId)) {
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

      if(!await this.verifyPlayer({
        steam_id: players_by_pk.steam_id,
        is_banned: players_by_pk.is_banned,
        matchmaking_cooldown: players_by_pk.matchmaking_cooldown,
      })) {
        return;
      }
      
      return {
        id: lobbyId,
        players: [{
          steam_id: players_by_pk.steam_id,
        }],
      }
    }

    const captain = lobby.players.find((player) => {
      return player.steam_id === user.steam_id && player.captain === true;
    });

    if(!captain) {
      this.logger.warn(`${user.steam_id} is not a captain of ${lobbyId}`);
      return;
    }

    for (const { player } of lobby.players) {
      if (
        !(await this.verifyPlayer({
          steam_id: player.steam_id,
          is_banned: player.is_banned,
          matchmaking_cooldown: player.matchmaking_cooldown,
        }))
      ) {
        return;
      }
    }

    return {
      id: lobbyId,
      players: lobby.players,
    };
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
    // TDOO - use SET to check if they are already in queue
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
