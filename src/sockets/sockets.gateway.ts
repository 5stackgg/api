import { ConnectedSocket, WebSocketGateway } from "@nestjs/websockets";
import { v4 as uuidv4 } from "uuid";
import { Request } from "express";
import session from "express-session";
import { getCookieOptions } from "../utilities/getCookieOptions";
import RedisStore from "connect-redis";
import passport from "passport";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { AppConfig } from "src/configs/types/AppConfig";
import { Redis } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { MatchMakingService } from "../match-making/match-making.servcie";
import { FiveStackWebSocketClient } from "./types/FiveStackWebSocketClient";

@WebSocketGateway({
  path: "/ws/web",
})
export class SocketsGateway {
  private redis: Redis;
  private appConfig: AppConfig;
  private nodeId: string = process.env.POD_NAME;
  private clients: Map<string, FiveStackWebSocketClient> = new Map();

  constructor(
    private readonly config: ConfigService,
    private readonly matchMaking: MatchMakingService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.redis = this.redisManager.getConnection();
    this.appConfig = this.config.get<AppConfig>("app");

    const sub = this.redisManager.getConnection("sub");

    sub.subscribe("broadcast-message");
    sub.subscribe("send-message-to-steam-id");
    sub.on("message", (channel, message) => {
      const { steamId, event, data } = JSON.parse(message) as {
        steamId: string;
        event: string;
        data: unknown;
      };

      switch (channel) {
        case "broadcast-message":
          this.broadcastMessage(event, data);
          break;
        case "send-message-to-steam-id":
          this.sendMessageToClient(steamId, event, data);
          break;
      }
    });
  }

  async handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request,
  ) {
    await this.setupSocket(client, request);
  }

  public static GET_CLIENT_CLIENT_KEY(steamId: string) {
    return `ws-clients:${steamId}:clients`;
  }

  public async setupSocket(client: FiveStackWebSocketClient, request: Request) {
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
      // luckily in this case the middlewares do not require the response
      // this is a hack to get the session loaded in a websocket
    })(request, {}, () => {
      passport.session()(request, {}, async () => {
        if (!request.user) {
          client.close();
          return;
        }

        client.id = uuidv4();
        client.user = request.user;
        client.node = this.nodeId;

        await this.cleanClients(client.user.steam_id);

        const clientKey = SocketsGateway.GET_CLIENT_CLIENT_KEY(
          client.user.steam_id,
        );
        const clientValue = `${client.id}:${client.node}`;

        await this.redis.sadd(clientKey, clientValue);

        this.clients.set(client.id, client);

        await this.sendPeopleOnline();
        await this.matchMaking.sendRegionStats(client.user);
        await this.matchMaking.sendQueueDetailsToUser(client.user.steam_id);

        client.on("close", async () => {
          await this.redis.srem(clientKey, clientValue);

          const clients = await this.redis.smembers(clientKey);

          await this.cleanClients(client.user.steam_id);

          if (clients.length === 0) {
            await this.redis.del(`user:${client.user.steam_id}`);
          }

          this.clients.delete(client.id);

          await this.sendPeopleOnline();
        });
      });
    });
  }

  public async broadcastMessage(event: string, data: unknown) {
    for (const client of Array.from(this.clients.values())) {
      client.send(
        JSON.stringify({
          event,
          data,
        }),
      );
    }
  }

  public async sendMessageToClient(
    steamId: string,
    event: string,
    data: unknown,
  ) {
    const clients = await this.redis.smembers(
      SocketsGateway.GET_CLIENT_CLIENT_KEY(steamId),
    );
    for (const client of clients) {
      const _client = await this.getClient(steamId, client);

      if (!_client) {
        continue;
      }

      _client.send(
        JSON.stringify({
          event,
          data,
        }),
      );
    }
  }

  private async sendPeopleOnline() {
    const players = await this.redis.keys("user:*");

    this.broadcastMessage(
      `players-online`,
      players.map((player) => player.slice(5)),
    );
  }

  private async cleanClients(steamId: string) {
    const clients = await this.redis.smembers(
      SocketsGateway.GET_CLIENT_CLIENT_KEY(steamId),
    );
    for (const client of clients) {
      await this.getClient(steamId, client);
    }
  }

  private async getClient(steamId: string, client: string) {
    const [id, node] = client.split(":");

    if (node !== this.nodeId) {
      return;
    }

    const _client = this.clients.get(id);

    if (_client) {
      return _client;
    }

    if (!_client) {
      await this.redis.srem(
        SocketsGateway.GET_CLIENT_CLIENT_KEY(steamId),
        client,
      );
    }
  }
}