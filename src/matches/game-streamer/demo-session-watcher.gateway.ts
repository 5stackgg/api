import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { FiveStackWebSocketClient } from "../../sockets/types/FiveStackWebSocketClient";
import { DemoSessionWatcherService } from "./demo-session-watcher.service";
import {
  DEMO_CONTROL_ACTIONS,
  DemoControlAction,
  GameStreamerService,
} from "./game-streamer.service";

@WebSocketGateway({ path: "/ws/web" })
export class DemoSessionWatcherGateway {
  constructor(
    private readonly logger: Logger,
    private readonly watcher: DemoSessionWatcherService,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  @SubscribeMessage("demo-session:watch")
  public async onWatch(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    @MessageBody() body: { match_map_id?: string },
  ) {
    if (!client.user) return;
    const matchMapId = body?.match_map_id;
    if (!matchMapId) return;

    this.watcher.register(client.id, {
      matchMapId,
      userSteamId: client.user.steam_id,
    });
    await this.gameStreamer.pingDemoSession(matchMapId, client.user.steam_id);
  }

  @SubscribeMessage("demo-session:unwatch")
  public onUnwatch(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    @MessageBody() body: { match_map_id?: string },
  ) {
    if (!client.user || !body?.match_map_id) return;
    this.watcher.unregister(client.id, body.match_map_id, client.user.steam_id);
  }

  @SubscribeMessage("demo-session:control")
  public async onControl(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    @MessageBody()
    body: {
      match_map_id?: string;
      action?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    if (!client.user || !body?.match_map_id || !body.action) return;
    if (!DEMO_CONTROL_ACTIONS.has(body.action as DemoControlAction)) return;
    try {
      const result = await this.gameStreamer.demoControl(
        body.match_map_id,
        client.user.steam_id,
        body.action as DemoControlAction,
        body.payload ?? {},
      );
      if (body.action === "state") {
        client.send(
          JSON.stringify({
            event: "demo-session:state",
            data: { match_map_id: body.match_map_id, state: result },
          }),
        );
      }
    } catch (error) {
      this.logger.warn(
        `[demo-watcher] control ${body.action} failed for ${body.match_map_id}/${client.user.steam_id}: ${(error as Error)?.message}`,
      );
    }
  }
}
