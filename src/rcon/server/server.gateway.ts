import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import WebSocket from "ws";
import passport from "passport";
import { Request } from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import { User } from "../../auth/types/User";
import { RconService } from "../rcon.service";
import { getCookieOptions } from "../../utilities/getCookieOptions";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../configs/types/AppConfig";

type FiveStackWebSocketClient = WebSocket.WebSocket & {
  user: User;
};

@WebSocketGateway({
  path: "/ws",
})
export class ServerGateway {
  constructor(
    private readonly config: ConfigService,
    private readonly rconService: RconService,
    private readonly redisManager: RedisManagerService
  ) {}

  handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request
  ) {
    const appConfig = this.config.get<AppConfig>("app");

    session({
      rolling: true,
      resave: false,
      name: appConfig.name,
      saveUninitialized: false,
      secret: appConfig.encSecret,
      cookie: getCookieOptions(),
      store: new RedisStore({
        prefix: appConfig.name,
        client: this.redisManager.getConnection(),
      }),
      // @ts-ignore
      // luckily in this case the middlewares do not require teh response
      // this is a hack to get the session loaded in a websocket
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
