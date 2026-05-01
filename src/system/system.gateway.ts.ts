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

interface ActiveLogStream {
  stream: PassThrough;
  onClientClose: () => void;
}

const activeLogStreams = new WeakMap<
  FiveStackWebSocketClient,
  ActiveLogStream
>();

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
    const resolvedService = service.startsWith("cs-update:")
      ? GameServerNodeService.GET_UPDATE_JOB_NAME(
          service.replace("cs-update:", ""),
        )
      : service;

    const previousActive = activeLogStreams.get(client);
    if (previousActive) {
      client.removeListener("close", previousActive.onClientClose);
      if (!previousActive.stream.destroyed) {
        previousActive.stream.destroy();
      }
      activeLogStreams.delete(client);
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

    const onClientClose = () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    };
    client.on("close", onClientClose);

    const cleanup = () => {
      client.removeListener("close", onClientClose);
      if (activeLogStreams.get(client)?.stream === stream) {
        activeLogStreams.delete(client);
      }
    };

    stream.on("close", cleanup);

    activeLogStreams.set(client, { stream, onClientClose });

    stream.on("end", async () => {
      let jobFinshed = false;
      if (isJob) {
        const jobStatus =
          await this.loggingService.getJobStatus(resolvedService);
        if (
          jobStatus?.succeeded ||
          (await this.loggingService.isJobTerminal(resolvedService))
        ) {
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
        resolvedService,
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
      if (!stream.destroyed) {
        stream.end();
      }
    }
  }
}
