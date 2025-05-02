import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { e_match_types_enum, e_player_roles } from "generated";
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
import { HasuraService } from "src/hasura/hasura.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";

@WebSocketGateway({
  path: "/ws/web",
})
export class MatchmakingGateway {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
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

    const { settings } = await this.hasura.query({
      settings: {
        __args: {
          where: {
            _or: [
              {
                name: {
                  _eq: "public.matchmaking",
                },
              },
              {
                name: {
                  _eq: "public.matchmaking_min_role",
                },
              },
            ],
          }
        },
        name: true,
        value: true,
      },
    });

    const matchmakingEnabled = settings.find(
      (setting) => setting.name === "public.matchmaking",
    );

    if(matchmakingEnabled && matchmakingEnabled.value === "false") {
      throw new JoinQueueError("Matchmaking is disabled");
    }

    const matchmakingMinRole = settings.find(
      (setting) => setting.name === "public.matchmaking_min_role",
    );

    if(matchmakingMinRole && !isRoleAbove(client.user.role, matchmakingMinRole.value as e_player_roles_enum)) {
      throw new JoinQueueError("You do not have permission to join this queue");
    }

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
