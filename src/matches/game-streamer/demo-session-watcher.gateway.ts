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

// Subscribe handlers for the demo-popup window's websocket. Lives on
// the same /ws/web path the rest of the app uses — Nest routes events
// by name so multiple gateways can share the connection.
//
// Lifecycle:
//   popup mount   → web sends "demo-session:watch" {match_map_id}
//   every 10s     → web re-sends "demo-session:watch" {match_map_id}
//                   (keeps last_activity_at fresh as a backstop for
//                    any close events the server misses)
//   popup close   → WS connection drops → SocketsService close handler
//                   calls watcher.clientClosed → session torn down
//   user clicks
//   "Cancel"      → web sends "demo-session:unwatch" first, so the
//                   close handler is a no-op
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
    // Bump activity even if the watcher was already registered —
    // serves as the heartbeat for the DB-side reaper without a
    // separate ping channel.
    await this.gameStreamer.pingDemoSession(matchMapId, client.user.steam_id);
  }

  @SubscribeMessage("demo-session:unwatch")
  public onUnwatch(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    @MessageBody() body: { match_map_id?: string },
  ) {
    if (!client.user || !body?.match_map_id) return;
    this.watcher.unregister(
      client.id,
      body.match_map_id,
      client.user.steam_id,
    );
  }

  /**
   * Interactive control (pause / seek / speed / etc). Fire-and-forget
   * over WS — much lower latency than a Hasura action round-trip, and
   * the only response the UI cares about is the next subscription
   * update on the session row (status / activity timestamps). Errors
   * from the spec-server proxy are logged here but not surfaced; the
   * UI optimistically updates from the user action and the next
   * subscription tick is the source of truth.
   *
   * Auth: the demoControl call already validates that the user owns
   * an active session for this matchMapId — clients can't control
   * sessions they don't own.
   */
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
      await this.gameStreamer.demoControl(
        body.match_map_id,
        client.user.steam_id,
        body.action as DemoControlAction,
        body.payload ?? {},
      );
    } catch (error) {
      this.logger.warn(
        `[demo-watcher] control ${body.action} failed for ${body.match_map_id}/${client.user.steam_id}: ${(error as Error)?.message}`,
      );
    }
  }
}
