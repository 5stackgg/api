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
      tailLines?: number;
      since?: {
        start: string;
        until: string;
      };
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    let { service, previous, tailLines, since } = data;

    if (!isRoleAbove(client.user.role, "administrator")) {
      return;
    }

    const isJob = service.startsWith("cs-update:") || service.startsWith("m-");

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

    stream.on("end", async () => {
      let jobFinshed = false;
      if (isJob) {
        const jobStatus = await this.loggingService.getJobStatus(service);
        if (jobStatus?.succeeded) {
          jobFinshed = true;
        }
      }

      client.send(
        JSON.stringify({
          event: `logs:${service}`,
          data: JSON.stringify({
            end: true,
            partial: !!since,
            job_finshed: jobFinshed,
          }),
        }),
      );
    });

    try {
      await this.loggingService.getServiceLogs(
        service.startsWith("cs-update:")
          ? GameServerNodeService.GET_UPDATE_JOB_NAME(
              service.replace("cs-update:", ""),
            )
          : service,
        stream,
        tailLines,
        !!previous,
        false,
        isJob,
        since,
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
