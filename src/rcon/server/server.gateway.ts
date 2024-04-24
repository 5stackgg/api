import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import WebSocket from "ws";
import passport from "passport";
import session from "express-session";
import RedisStore from "connect-redis";
import { User } from "../../auth/types/User";
import { RconService } from "../rcon.service";
import { getCookieOptions } from "../../utilities/getCookieOptions";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";

type FiveStackWebSocketClient = WebSocket.WebSocket & {
  user: User;
};

@WebSocketGateway({
  path: "/ws",
})
export class ServerGateway {
  constructor(
    private readonly rconService: RconService,
    private readonly redisManager: RedisManagerService
  ) {}

  handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request
  ) {
    const appName = process.env.APP_NAME || "5stack";

    session({
      rolling: true,
      resave: false,
      name: appName,
      saveUninitialized: false,
      secret: process.env.ENC_SECRET as string,
      cookie: getCookieOptions(),
      store: new RedisStore({
        prefix: appName,
        client: this.redisManager.getConnection(),
      }),
      // @ts-ignore
    })(request, {}, () => {
      passport.session()(request, {}, () => {
        if (!request.user) {
          client.close();
          return;
        }
        client.user = request.user;
      });
    });
  }

  @SubscribeMessage("rcon")
  async onEvent(
    @MessageBody()
    data: {
      uuid: string;
      command: string;
      serverId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient
  ) {
    const rcon = await this.rconService.connect(data.serverId);

    client.send(
      JSON.stringify({
        event: "rcon",
        data: {
          uuid: data.uuid,
          result: await rcon.send(data.command),
        },
      })
    );
  }
}
