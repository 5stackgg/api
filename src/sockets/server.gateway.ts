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
import { User } from "../auth/types/User";
import { RconService } from "../rcon/rcon.service";
import { getCookieOptions } from "../utilities/getCookieOptions";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../configs/types/AppConfig";

type FiveStackWebSocketClient = WebSocket.WebSocket & {
  user: User;
};

/**
 * TODO - use redis to keep state,
 * right now this is not scaleable because were using a single service to track sessions
 */
@WebSocketGateway({
  path: "/ws",
})
export class ServerGateway {
  private matches: Record<
    string,
    Map<
      string,
      {
        user: User;
        sessions: Array<FiveStackWebSocketClient>;
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

    let userData = this.matches[data.matchId].get(client.user.steam_id);

    if (!userData) {
      userData = {
        sessions: [],
        user: client.user,
      };
      this.matches[data.matchId].set(client.user.steam_id, userData);
    }

    const { name, steam_id, avatar_url } = client.user;

    if (userData.sessions.length === 0) {
      this.sendToLobby(`lobby`, data.matchId, {
        event: "joined",
        user: {
          name,
          steam_id,
          avatar_url,
        },
        client,
      });
    }

    userData.sessions.push(client);

    client.send(
      JSON.stringify({
        event: "lobby",
        data: {
          event: "list",
          matchId: data.matchId,
          lobby: Array.from(this.matches[data.matchId].values()).map(
            ({ user }) => {
              return user;
            },
          ),
        },
      }),
    );

    client.on("close", () => {
      userData.sessions = userData.sessions.filter((_client) => {
        return _client !== client;
      });

      if (userData.sessions.length === 0) {
        this.matches[data.matchId].delete(client.user.steam_id);
        this.sendToLobby("lobby", data.matchId, {
          event: "left",
          user: {
            steam_id: client.user.steam_id,
          },
        });
      }
    });
  }

  @SubscribeMessage("lobby:chat")
  async lobby(
    @MessageBody()
    data: {
      matchId: string;
      message: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    this.sendToLobby("lobby:chat", data.matchId, {
      event: "message",
      data: {
        message: data.message,
        time: new Date().toISOString(),
        from: {
          name: client.user.name,
          steam_id: client.user.steam_id,
          avatar_url: client.user.avatar_url,
          profile_url: client.user.profile_url,
        },
      },
    });
  }

  private sendToLobby(
    event: string,
    matchId: string,
    data: Record<string, any>,
    sender?: FiveStackWebSocketClient,
  ) {
    for (const [, data] of this.matches[matchId]) {
      for (const session of data.sessions) {
        if (sender === session) {
          continue;
        }

        session.send(
          JSON.stringify({
            event,
            data: {
              matchId,
              ...data,
            },
          }),
        );
      }
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
