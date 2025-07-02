import { PassThrough } from "stream";
import { Logger } from "@nestjs/common";
import { LoggingServiceService } from "src/game-server-node/logging-service/logging-service.service";

import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";

@WebSocketGateway({
  path: "/ws/web",
})
export class SystemGateway {
  constructor(
    protected readonly logger: Logger,
    protected readonly loggingService: LoggingServiceService,
  ) {}

  @SubscribeMessage("logs")
  async logEvent(
    @MessageBody()
    data: {
      service: string;
      previous?: boolean;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const { service, previous } = data;

    if (client.user.role !== "administrator") {
      return;
    }

    const stream = new PassThrough();

    stream.on("data", (chunk) => {
      client.send(
        JSON.stringify({
          event: `logs:${service}`,
          data: chunk.toString(),
        }),
      );
    });

    client.on("close", () => {
      stream.end();
    });

    try {
      await this.loggingService.getServiceLogs(service, stream, !!previous);
    } catch (error) {
      this.logger.warn(
        "unable to get logs:",
        error?.body?.message || error.message,
      );
      stream.end();
    }
  }
}
