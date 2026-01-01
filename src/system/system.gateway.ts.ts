import { PassThrough } from "stream";
import { Logger } from "@nestjs/common";

import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { GameServerNodeService } from "src/game-server-node/game-server-node.service";
import { LoggingService } from "src/k8s/logging/logging.service";

@WebSocketGateway({
  path: "/ws/web",
})
export class SystemGateway {
  constructor(
    protected readonly logger: Logger,
    protected readonly loggingService: LoggingService,
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
    let { service, previous } = data;

    if (!isRoleAbove(client.user.role, "administrator")) {
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

    stream.on("end", () => {
      client.send(
        JSON.stringify({
          event: `logs:${service}`,
          data: JSON.stringify({
            end: true,
          }),
        }),
      );
    });

    let isJob = service.startsWith("cs-update:");

    try {
      await this.loggingService.getServiceLogs(
        service.startsWith("cs-update:")
          ? GameServerNodeService.GET_UPDATE_JOB_NAME(
              service.replace("cs-update:", ""),
            )
          : service,
        stream,
        !!previous,
        false,
        isJob,
      );
    } catch (error) {
      this.logger.warn(
        "unable to get logs:",
        error?.body?.message || error.message,
      );
      stream.end();
    }
  }
}
