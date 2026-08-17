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

  // Relayed rather than derived: only the device that took the microphone or the
  // camera knows it took it, and it is the player's own clients that need to be
  // told. Everyone else already sees the same call either way.
  @SubscribeMessage("voice:device-claim")
  public async deviceClaim(
    @MessageBody()
    data: { channelId?: string; kind?: "mic" | "cam"; claimed?: boolean },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (
      !client.user ||
      !data?.channelId ||
      (data.kind !== "mic" && data.kind !== "cam")
    ) {
      return;
    }

    try {
      await this.voice.relayDeviceClaim(
        data.channelId,
        client.user,
        data.kind,
        data.claimed === true,
      );
    } catch (error) {
      this.logger.debug(
        `[voice] ignoring device claim from ${client.user.steam_id}: ${
          (error as Error)?.message
        }`,
      );
    }
  }

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
