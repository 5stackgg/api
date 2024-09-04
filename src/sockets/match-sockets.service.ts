import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { FiveStackWebSocketClient } from "./server.gateway";
import session from "express-session";
import { getCookieOptions } from "../utilities/getCookieOptions";
import RedisStore from "connect-redis";
import passport from "passport";
import { AppConfig } from "../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { Request } from "express";
import { RconService } from "../rcon/rcon.service";

@Injectable()
export class MatchSocketsService {
  private redis: Redis;
  private appConfig: AppConfig;
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
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly config: ConfigService,
    private readonly hasuraService: HasuraService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.redis = this.redisManager.getConnection();
    this.appConfig = this.config.get<AppConfig>("app");
  }

  public isInLobby() {}

  public async joinLobby(client: FiveStackWebSocketClient, matchId: string) {
    const { matches_by_pk } = await this.hasuraService.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
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

    if (!this.matches[matchId]) {
      this.matches[matchId] = new Map();
    }

    let userData = this.matches[matchId].get(client.user.steam_id);

    if (!userData) {
      userData = {
        sessions: [],
        user: client.user,
      };
      this.matches[matchId].set(client.user.steam_id, userData);
    }

    const { name, steam_id, avatar_url } = client.user;

    if (userData.sessions.length === 0) {
      this.sendToLobby(`lobby:joined`, matchId, {
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
          matchId: matchId,
          lobby: Array.from(this.matches[matchId].values()).map(({ user }) => {
            return user;
          }),
        },
      }),
    );

    const messagesObject = await this.redis.hgetall(`chat_${matchId}`);

    const messages = Object.entries(messagesObject).map(([, value]) =>
      JSON.parse(value),
    );

    client.send(
      JSON.stringify({
        event: "lobby:messages",
        data: {
          messages,
          matchId: matchId,
        },
      }),
    );

    client.on("close", () => {
      this.removeFromLobby(matchId, client);
    });
  }

  public setupSocket(client: FiveStackWebSocketClient, request: Request) {
    session({
      rolling: true,
      resave: false,
      name: this.appConfig.name,
      saveUninitialized: false,
      secret: this.appConfig.encSecret,
      cookie: getCookieOptions(),
      store: new RedisStore({
        prefix: this.appConfig.name,
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

  public async sendMessageToChat(
    player: User,
    matchId: string,
    _message: string,
    skipCheck = false,
  ) {
    // verify they are in the lobby
    if (skipCheck === false && !this.matches[matchId]?.get(player.steam_id)) {
      return;
    }

    const timestamp = new Date();

    // TODO - we should fetch the user on the UI instead
    const message = {
      message: _message,
      timestamp: timestamp.toISOString(),
      from: {
        role: player.role,
        name: player.name,
        steam_id: player.steam_id,
        avatar_url: player.avatar_url,
        profile_url: player.profile_url,
      },
    };

    const messageKey = `chat_${matchId}`;
    const messageField = `${player.steam_id}:${Date.now().toString()}`;
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

    this.sendToLobby("lobby:chat", matchId, message);
  }

  public sendToLobby(
    event: string,
    matchId: string,
    data: Record<string, any>,
    sender?: FiveStackWebSocketClient,
  ) {
    const clients = this.matches?.[matchId];

    if (!clients) {
      return;
    }

    for (const [, userData] of clients) {
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

  public removeFromLobby(matchId: string, client: FiveStackWebSocketClient) {
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

  public async sendChatToServer(matchId: string, message: string) {
    try {
      const { matches_by_pk } = await this.hasuraService.query({
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          server: {
            id: true,
          },
        },
      });

      const server = matches_by_pk.server;
      if (!server) {
        return;
      }

      const rcon = await this.rcon.connect(server.id);

      return await rcon.send(`css_web_chat "${message}"`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send match to server`,
        error.message,
      );
    }
  }
}
