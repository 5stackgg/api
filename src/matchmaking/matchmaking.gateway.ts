import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { e_match_types_enum } from "generated";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { JoinQueueError } from "./utilities/joinQueueError";

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

  @SubscribeMessage("matchmaking:join-queue")
  async joinQueue(
    @MessageBody()
    data: {
      type: e_match_types_enum;
      regions: Array<string>;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    let lobby;
    const user = client.user;
    const { type, regions } = data;

    if (!user) {
      return;
    }

    try {
      if (!type || !regions || regions.length === 0) {
        throw new JoinQueueError("Missing Type or Regions");
      }

      lobby = await this.matchmakingLobbyService.getPlayerLobby(user);

      if (!lobby) {
        throw new JoinQueueError("Unable to find Player Lobby");
      }

      await this.matchmakingLobbyService.verifyLobby(lobby, user);

      try {
        await this.matchmakingLobbyService.setLobbyDetails(
          regions,
          type,
          lobby,
        );
        await this.matchmakeService.addLobbyToQueue(lobby.id);
      } catch (error) {
        this.logger.error(`unable to add lobby to queue`, error);
        await this.matchmakingLobbyService.removeLobbyFromQueue(lobby.id);
        throw new JoinQueueError("Unknown Error");
      }

      await this.matchmakeService.sendRegionStats();

      for (const region of regions) {
        this.matchmakeService.matchmake(type, region);
      }
    } catch (error) {
      if (error instanceof JoinQueueError) {
        let steamIds = [user.steam_id];

        if (lobby && error.getLobbyId()) {
          steamIds = lobby.players.map((player) => player.steam_id);
        }

        console.info("SEND ERROR TO ", steamIds);
        for (const steamId of steamIds) {
          await this.redis.publish(
            `send-message-to-steam-id`,
            JSON.stringify({
              steamId,
              event: "matchmaking:error",
              data: {
                message: error.message,
              },
            }),
          );
        }

        return;
      }
      this.logger.error(`unable to join queue`, error);
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

  @SubscribeMessage("matchmaking:confirm")
  async playerConfirmation(
    @MessageBody()
    data: {
      confirmationId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const user = client.user;
    if (!user) {
      return;
    }
    const { confirmationId } = data;

    await this.matchmakeService.playerConfirmMatchmaking(
      confirmationId,
      user.steam_id,
    );
  }
}
