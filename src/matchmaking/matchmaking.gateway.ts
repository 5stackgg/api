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
      return;
    }

    await this.matchmakingLobbyService.setLobbyDetails(regions, type, lobby);

    await this.matchmakeService.addLobbyToQueue(lobby.id);

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
