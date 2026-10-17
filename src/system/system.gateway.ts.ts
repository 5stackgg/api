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
import { GameStreamerService } from "src/matches/game-streamer/game-streamer.service";
import { LoggingService } from "src/k8s/logging/logging.service";
import { MapAssetsService } from "src/map-assets/map-assets.service";

interface ActiveLogStream {
  service: string;
  stream: PassThrough;
  onClientClose: () => void;
}

const activeLogStreams = new WeakMap<
  FiveStackWebSocketClient,
  ActiveLogStream
>();

function stopLogStream(client: FiveStackWebSocketClient) {
  const active = activeLogStreams.get(client);
  if (!active) {
    return;
  }

  client.removeListener("close", active.onClientClose);
  if (!active.stream.destroyed) {
    active.stream.destroy();
  }
  activeLogStreams.delete(client);
}

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
    await client.authentication;

    if (!client.user || !isRoleAbove(client.user.role, "administrator")) {
      return;
    }

    let { service, previous, tailLines, since } = data;

    // m- = match jobs, u- = utility practice jobs, gs- = game-streamer jobs; all read by job-name label.
    const isJob =
      service.startsWith("cs-update:") ||
      service.startsWith("shader-bake:") ||
      service.startsWith("map-assets:") ||
      service.startsWith("m-") ||
      service.startsWith("u-") ||
      service.startsWith("gs-");
    const resolvedService = service.startsWith("cs-update:")
      ? GameServerNodeService.GET_UPDATE_JOB_NAME(
          service.replace("cs-update:", ""),
        )
      : service.startsWith("shader-bake:")
        ? GameStreamerService.GET_BAKE_JOB_NAME(
            service.replace("shader-bake:", ""),
          )
        : service.startsWith("map-assets:")
          ? MapAssetsService.GET_JOB_NAME(service.replace("map-assets:", ""))
          : service;

    stopLogStream(client);

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

    activeLogStreams.set(client, { service, stream, onClientClose });

    stream.on("end", async () => {
      let jobFinshed = false;
      if (isJob) {
        const jobStatus =
          await this.loggingService.getJobStatus(resolvedService);
        if (jobStatus?.active) {
          // job is still running — never report finished, even if stale k8s
          // events from a previous same-named job look terminal
          jobFinshed = false;
        } else if (
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

  // Sent when the Logs page is left or hidden; a service names the stream the
  // page was showing, so a stop that arrives after a newer request is ignored.
  @SubscribeMessage("logs:stop")
  async stopLogs(
    @MessageBody() data: { service?: string } | undefined,
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    await client.authentication;

    if (!client.user || !isRoleAbove(client.user.role, "administrator")) {
      return;
    }

    const active = activeLogStreams.get(client);
    if (!active || (data?.service && data.service !== active.service)) {
      return;
    }

    stopLogStream(client);
  }
}
