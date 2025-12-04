import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import WebSocket from "ws";
import { Request } from "express";
import { ModuleRef } from "@nestjs/core";
import { MatchEvents } from "./events";
import MatchEventProcessor from "./events/abstracts/MatchEventProcessor";
import { Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";

export type FiveStackGameServerWebSocketClient = WebSocket.WebSocket & {
  id: string;
  matchId: string;
};

@WebSocketGateway({
  path: "/ws/matches",
})
export class MatchEventsGateway {
  constructor(
    private readonly logger: Logger,
    private readonly moduleRef: ModuleRef,
    private readonly hasura: HasuraService,
    private readonly cache: CacheService,
  ) {}

  async handleConnection(
    @ConnectedSocket() client: WebSocket.WebSocket,
    request: Request,
  ) {
    try {
      const authHeader = request.headers.authorization;

      if (authHeader && authHeader.startsWith("Basic ")) {
        const base64Credentials = authHeader.split(" ").at(1);

        const [serverId, apiPassword] = Buffer.from(base64Credentials, "base64")
          .toString()
          .split(":");

        const { servers_by_pk } = await this.hasura.query({
          servers_by_pk: {
            __args: {
              id: serverId,
            },
            id: true,
            api_password: true,
          },
        });

        if (servers_by_pk?.api_password !== apiPassword) {
          client.close();
          this.logger.warn("game server auth failure", {
            serverId,
            ip: request.headers["cf-connecting-ip"],
          });
        }
      }
    } catch {
      client.close();
    }
  }

  @SubscribeMessage("events")
  async handleMatchEvent(
    @MessageBody()
    message: {
      mapId?: string;
      matchId: string;
      messageId: string;
      data: {
        event: string;
        data: Record<string, unknown>;
      };
    },
  ) {
    const { matchId, mapId, messageId } = message;

    const cacheKey = mapId
      ? `match-events:${matchId}:${mapId}:${messageId}`
      : `match-events:${matchId}:${messageId}`;

    if (await this.cache.has(cacheKey)) {
      return messageId;
    }

    await this.cache.put(cacheKey, true, 10);

    const { data, event } = message.data;

    const Processor = MatchEvents[event as keyof typeof MatchEvents];

    if (!Processor) {
      this.logger.warn("unable to find event handler", event);
      return;
    }

    const processor =
      await this.moduleRef.resolve<MatchEventProcessor<unknown>>(Processor);

    processor.setData(matchId, data);

    await processor.process();

    return messageId;
  }
}
