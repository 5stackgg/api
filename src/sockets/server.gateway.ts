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
import Redis from "ioredis";
import { HasuraService } from "../hasura/hasura.service";

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
  private redis: Redis;
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
    private readonly hasuraService: HasuraService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

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
        client: this.redis,
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
    const { matches_by_pk } = await this.hasuraService.query(
      {
        matches_by_pk: {
          __args: {
            id: data.matchId,
          },
          is_coach: true,
          is_organizer: true,
          is_in_lineup: true,
        },
      },
      client.user,
    );

    if (!matches_by_pk) {
      return;
    }
    if (
      matches_by_pk.is_coach === false &&
      matches_by_pk.is_in_lineup === false &&
      matches_by_pk.is_organizer === false
    ) {
      return;
    }

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
      this.sendToLobby(`lobby:joined`, data.matchId, {
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
        event: "lobby:list",
        data: {
          matchId: data.matchId,
          lobby: Array.from(this.matches[data.matchId].values()).map(
            ({ user }) => {
              return user;
            },
          ),
        },
      }),
    );

    const messagesObject = await this.redis.hgetall(`chat_${data.matchId}`);

    const messages = Object.entries(messagesObject)
      .map(([, value]) => JSON.parse(value))
      .reverse();

    client.send(
      JSON.stringify({
        event: "lobby:messages",
        data: {
          messages,
          matchId: data.matchId,
        },
      }),
    );

    client.on("close", () => {
      this.removeFromLobby(data.matchId, client);
    });
  }

  @SubscribeMessage("lobby:leave")
  async leaveLobby(
    @MessageBody()
    data: {
      matchId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    this.removeFromLobby(data.matchId, client);
  }

  private removeFromLobby(matchId: string, client: FiveStackWebSocketClient) {
    const userData = this.matches[matchId]?.get(client.user.steam_id);

    if (!userData) {
      return;
    }

    userData.sessions = userData.sessions.filter((_client) => {
      return _client !== client;
    });

    if (userData.sessions.length === 0) {
      this.matches[matchId].delete(client.user.steam_id);
      this.sendToLobby("lobby:left", matchId, {
        user: {
          steam_id: client.user.steam_id,
        },
      });
    }
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
    // verify they are in the lobby
    if (!this.matches[data.matchId]?.get(client.user.steam_id)) {
      return;
    }

    const timestamp = new Date();

    // TODO - we should fetch the user on the UI instead
    const message = {
      message: data.message,
      timestamp: timestamp.toISOString(),
      from: {
        role: client.user.role,
        name: client.user.name,
        steam_id: client.user.steam_id,
        avatar_url: client.user.avatar_url,
        profile_url: client.user.profile_url,
      },
    };

    const messageKey = `chat_${data.matchId}`;
    const messageField = `${client.user.steam_id}:${Date.now().toString()}`;
    await this.redis.hset(messageKey, messageField, JSON.stringify(message));

    await this.redis.sendCommand(
      new Redis.Command("HEXPIRE", [
        messageKey,
        60 * 60,
        "FIELDS",
        1,
        messageField,
      ]),
    );

    this.sendToLobby("lobby:chat", data.matchId, message);
  }

  private sendToLobby(
    event: string,
    matchId: string,
    data: Record<string, any>,
    sender?: FiveStackWebSocketClient,
  ) {
    for (const [, userData] of this.matches[matchId]) {
      for (const session of userData.sessions) {
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
