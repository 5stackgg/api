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
  private matches: Record<
    string,
    Map<
      string,
      {
        sessions: number;
        client: FiveStackWebSocketClient;
      }
    >
  > = {};

  constructor(
    private readonly config: ConfigService,
    private readonly rconService: RconService,
    private readonly redisManager: RedisManagerService,
  ) {}

  handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request,
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

  @SubscribeMessage("lobby:join")
  async joinLobby(
    @MessageBody()
    data: {
      matchId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!this.matches[data.matchId]) {
      this.matches[data.matchId] = new Map();
    }

    let matchClientSessions = this.matches[data.matchId].get(
      client.user.steam_id,
    );

    if (!matchClientSessions) {
      matchClientSessions = {
        client,
        sessions: 0,
      };
      this.matches[data.matchId].set(client.user.steam_id, matchClientSessions);
    }

    matchClientSessions.sessions++;

    const { name, steam_id, avatar_url } = client.user;

    this.sendToLobby(data.matchId, {
      event: "joined",
      user: {
        name,
        steam_id,
        avatar_url,
      },
      client,
    });

    client.send(
      JSON.stringify({
        event: "lobby",
        data: {
          event: "list",
          matchId: data.matchId,
          lobby: Array.from(this.matches[data.matchId].values()).map(
            ({ client }) => {
              return {
                name: client.user.name,
                steam_id: client.user.steam_id,
                avatar_url: client.user.avatar_url,
              };
            },
          ),
        },
      }),
    );

    client.on("close", () => {
      matchClientSessions.sessions--;
      if (matchClientSessions.sessions === 0) {
        this.matches[data.matchId].delete(client.user.steam_id);
        this.sendToLobby(data.matchId, {
          event: "left",
          user: {
            steam_id,
          },
        });
      }
    });
  }

  @SubscribeMessage("lobby")
  async lobby(
    @MessageBody()
    data: {
      matchId: string;
      message: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    this.sendToLobby(data.matchId, {
      message: data.message,
      client,
    });
  }

  private sendToLobby(
    matchId: string,
    data: Record<string, any>,
    sender?: FiveStackWebSocketClient,
  ) {
    for (const [, { client }] of this.matches[matchId]) {
      if (sender === client) {
        continue;
      }

      client.send(
        JSON.stringify({
          event: "lobby",
          data: {
            matchId,
            ...data,
          },
        }),
      );
    }
  }

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
    const rcon = await this.rconService.connect(data.serverId);

    client.send(
      JSON.stringify({
        event: "rcon",
        data: {
          uuid: data.uuid,
          result: await rcon.send(data.command),
        },
      }),
    );
  }
}
