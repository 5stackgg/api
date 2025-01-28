import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { e_match_types_enum } from "generated";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { MatchmakeService } from "./matchmake.service";

@WebSocketGateway({
  path: "/ws/web",
})
export class MatchmakingGateway {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly redisManager: RedisManagerService,
    public readonly matchmakeService: MatchmakeService,
    public readonly matchmakingLobbyService: MatchmakingLobbyService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  // TODO - make a SET for each player that bleongs to a lobb

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

    const lobby = await this.matchmakingLobbyService.getPlayerLobby(user);

    if (!lobby) {
      return;
    }

    if (!(await this.matchmakingLobbyService.verifyLobby(lobby))) {
      // TODO - return an errror wny they cant join the queue
      return;
    }

    const joinedAt = new Date();

    await this.matchmakingLobbyService.setQueuedDetails(lobby.id, {
      type,
      regions,
      joinedAt,
      lobbyId: lobby.id,
      players: lobby.players.map(({ steam_id }) => steam_id),
    });

    const avgRank = await this.matchmakeService.getAverageLobbyRank(lobby.id);

    // Store the lobby's rank in a separate sorted set for quick rank matching
    for (const region of regions) {
      await this.redis.zadd(
        getMatchmakingRankCacheKey(type, region),
        avgRank,
        lobby.id,
      );
    }

    // for each region add lobby into the queue
    for (const region of regions) {
      // TODO - and speicic maps
      await this.redis.zadd(
        getMatchmakingQueueCacheKey(type, region),
        joinedAt.getTime(),
        lobby.id,
      );
    }

    await this.matchmakeService.sendQueueDetailsToLobby(lobby.id);
    await this.matchmakeService.sendRegionStats();

    for (const region of regions) {
      this.matchmakeService.matchmake(type, region);
    }
  }

  @SubscribeMessage("matchmaking:leave")
  async leaveQueue(@ConnectedSocket() client: FiveStackWebSocketClient) {
    const user = client.user;

    if (!user) {
      return;
    }

    const lobby = await this.matchmakingLobbyService.getPlayerLobby(user);

    if (!lobby) {
      return;
    }

    await this.matchmakingLobbyService.removeLobbyFromQueue(lobby.id);
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
    //     getMatchmakingConformationCacheKey(confirmationId),
    //     `${user.steam_id}`,
    //   )
    // ) {
    //   return;
    // }
    // /**
    //  * increment the number of players that have confirmed
    //  */
    // await this.redis.hincrby(
    //   getMatchmakingConformationCacheKey(confirmationId),
    //   "confirmed",
    //   1,
    // );
    // /**
    //  * set the user as confirmed
    //  */
    // await this.redis.hset(
    //   getMatchmakingConformationCacheKey(confirmationId),
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
    //   getMatchmakingConformationCacheKey(confirmationId),
    //   "matchId",
    //   match.id,
    // );
    // for (const steamId of players) {
    //   // this.sendQueueDetailsToLobby(lobbyId, steamId);
    // }
    // await this.matchAssistant.updateMatchStatus(match.id, "Veto");
  }
}
