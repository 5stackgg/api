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
          this.logger.warn("game server auth failure", serverId);
        }
      }
    } catch (error) {
      this.logger.error("unable to verify game server connection", error);
      client.close();
    }
  }

  @SubscribeMessage("events")
  async handleMatchEvent(
    @MessageBody()
    message: {
      matchId: string;
      data: {
        event: string;
        data: Record<string, unknown>;
      };
    },
    @ConnectedSocket() client: WebSocket.WebSocket,
  ) {
    const { matchId } = message;
    const { data, event } = message.data;

    const Processor = MatchEvents[event as keyof typeof MatchEvents];

    if (!Processor) {
      this.logger.warn("unable to find event handler", event);
      return;
    }

    const processor =
      await this.moduleRef.resolve<MatchEventProcessor<unknown>>(Processor);

    console.info("LETS GO", {
      matchId,
      data,
      event,
    });

    processor.setData(matchId, data);

    await processor.process();
  }
}
