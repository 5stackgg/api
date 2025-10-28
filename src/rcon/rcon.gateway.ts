import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { HasuraService } from "src/hasura/hasura.service";

@WebSocketGateway({
  path: "/ws/web",
})
export class RconGateway {
  constructor(
    private readonly hasura: HasuraService,
    private readonly rconService: RconService,
  ) {}

  @SubscribeMessage("rcon")
  async rconEvent(
    @MessageBody()
    data: {
      uuid: string;
      command: string;
      serverId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (
      !client.user ||
      client.user.role === "user" ||
      client.user.role === "verified_user" ||
      client.user.role === "streamer"
    ) {
      return;
    }

    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: data.serverId,
        },
        current_match: {
          is_tournament_match: true,
        },
      },
    });

    if (
      server.current_match?.is_tournament_match &&
      client.user.role === "match_organizer"
    ) {
      return;
    }

    const rcon = await this.rconService.connect(data.serverId);

    if (!rcon) {
      client.send(
        JSON.stringify({
          event: "rcon",
          data: {
            uuid: data.uuid,
            result: "unable to connect to rcon",
          },
        }),
      );

      return;
    }

    client.send(
      JSON.stringify({
        event: "rcon",
        data: {
          uuid: data.uuid,
          command: data.command,
          result: await rcon.send(data.command),
        },
      }),
    );
  }
}
