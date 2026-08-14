import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { FiveStackWebSocketClient } from "../sockets/types/FiveStackWebSocketClient";
import { VoiceService } from "./voice.service";

// Who is talking is only known to the client doing the talking: its gate is
// what decides whether the microphone is being sent, and MediaMTX sees the same
// continuous stream either way. So the client says, and this hands it to the
// rest of the channel.
@WebSocketGateway({
  path: "/ws/web",
})
export class VoiceGateway {
  constructor(
    private readonly logger: Logger,
    private readonly voice: VoiceService,
  ) {}

  @SubscribeMessage("voice:speaking")
  public async speaking(
    @MessageBody() data: { channelId?: string; speaking?: boolean },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user || !data?.channelId) {
      return;
    }

    try {
      await this.voice.setSpeaking(
        data.channelId,
        client.user,
        data.speaking === true,
      );
    } catch (error) {
      // Membership is re-checked on every event, so a stale client that has
      // been removed from the channel just stops being heard -- that is not
      // worth an error to anyone.
      this.logger.debug(
        `[voice] ignoring speaking from ${client.user.steam_id}: ${
          (error as Error)?.message
        }`,
      );
    }
  }
}
