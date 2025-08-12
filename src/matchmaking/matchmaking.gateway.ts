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
import { SocketsGateway } from "src/sockets/sockets.gateway";

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
          },
        },
        name: true,
        value: true,
      },
    });

    const matchmakingEnabled = settings.find(
      (setting) => setting.name === "public.matchmaking",
    );

    if (matchmakingEnabled && matchmakingEnabled.value === "false") {
      throw new JoinQueueError("Matchmaking is disabled");
    }

    const matchmakingMinRole = settings.find(
      (setting) => setting.name === "public.matchmaking_min_role",
    );

    if (
      matchmakingMinRole &&
      !isRoleAbove(
        client.user.role,
        matchmakingMinRole.value as e_player_roles_enum,
      )
    ) {
      throw new JoinQueueError("You do not have permission to join this queue");
    }

    let lobby;
    const user = client.user;

    if (!user) {
      return;
    }

    const latencyResults = await this.getLatencyResults(client);

    const { server_regions } = await this.hasura.query({
      server_regions: {
        __args: {
          where: {
            status: {
              _neq: "Disabled",
            },
          },
        },
        value: true,
        is_lan: true,
        status: true,
      },
    });

    // TODO - rather adding all regions at once we should add them when expanding the search

    let regions = [];
    for (const region of data.regions) {
      const server_region = server_regions.find((server_region) => {
        return server_region.value === region;
      });

      if (!server_region) {
        continue;
      }

      const latency =
        latencyResults[region.toLocaleLowerCase().replace(" ", "_")];
      if (!server_region.is_lan || latency?.isLan === true) {
        regions.push(server_region.value);
      }
    }

    if (regions.length === 0) {
      throw new JoinQueueError("No regions available");
    }

    const { type } = data;

    try {
      if (!type || !regions || regions.length === 0) {
        throw new JoinQueueError("Missing Type or Regions");
      }

      lobby = await this.matchmakingLobbyService.getPlayerLobby(user.steam_id);

      if (!lobby) {
        throw new JoinQueueError("Unable to find Player Lobby");
      }

      await this.matchmakingLobbyService.verifyLobby(lobby, user, type);

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
        await this.matchmakingLobbyService.removeLobbyDetails(lobby.id);
        throw new JoinQueueError("Unknown Error");
      }

      await this.matchmakeService.sendRegionStats();

      for (const region of regions) {
        void this.matchmakeService.matchmake(type, region);
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

    const lobby = await this.matchmakingLobbyService.getPlayerLobby(
      user.steam_id,
    );

    if (!lobby) {
      return;
    }

    await this.matchmakingLobbyService.removeLobbyFromQueue(lobby.id);
    await this.matchmakingLobbyService.removeLobbyDetails(lobby.id);
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

  private async getLatencyResults(client: FiveStackWebSocketClient) {
    const data = await this.redis.hgetall(
      SocketsGateway.GET_PLAYER_CLIENT_LATENCY_TEST(client.sessionId),
    );

    const latencyResults: Record<
      string,
      {
        isLan: boolean;
        latency: number;
      }
    > = {};

    for (const key in data) {
      latencyResults[key] = JSON.parse(data[key]);
    }

    return latencyResults;
  }
}
