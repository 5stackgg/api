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

  public static GET_CLIENT_CLIENTS_LIST_KEY(steamId: string) {
    return `ws-clients:${steamId}:clients`;
  }

  public static GET_AVAILABLE_NODES_KEY() {
    return `available-socket-nodes`;
  }

  public static GET_NODE_STATUS_KEY(nodeId: string) {
    return `socket-node:${nodeId}:status`;
  }

  public static GET_NODE_CLIENTS_KEY(nodeId: string) {
    return `socket-nodes:${nodeId}:clients`;
  }

  public static GET_CLIENT_NODE_KEY(clientId: string, nodeId: string) {
    return `${clientId}:${nodeId}`;
  }

  public static GET_STEAM_CLIENT_KEY(steamId: string, clientId: string) {
    return `${steamId}:${clientId}`;
  }

  public static GET_USER_CONNECTIONS_KEY(steamId: string) {
    return `user:${steamId}`;
  }

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

    void this.setupNode();
  }

  private async handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request,
  ) {
    await this.setupSocket(client, request);
  }

  private async setupSocket(
    client: FiveStackWebSocketClient,
    request: Request,
  ) {
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

        const nodeClientsKey = SocketsGateway.GET_NODE_CLIENTS_KEY(this.nodeId);
        const clientKey = SocketsGateway.GET_CLIENT_CLIENTS_LIST_KEY(
          client.user.steam_id,
        );
        const clientNodeKey = SocketsGateway.GET_CLIENT_NODE_KEY(
          client.id,
          this.nodeId,
        );
        const steamClientKey = SocketsGateway.GET_STEAM_CLIENT_KEY(
          client.id,
          client.user.steam_id,
        );

        await this.redis.sadd(clientKey, clientNodeKey);
        await this.redis.sadd(nodeClientsKey, steamClientKey);

        this.clients.set(client.id, client);

        await this.sendPeopleOnline();
        await this.matchMaking.sendRegionStats(client.user);
        await this.matchMaking.sendQueueDetailsToUser(client.user.steam_id);

        client.on("close", async () => {
          await this.redis.srem(clientKey, clientNodeKey);
          await this.redis.srem(nodeClientsKey, steamClientKey);

          const clients = await this.redis.smembers(clientKey);

          await this.cleanClients(client.user.steam_id);

          if (clients.length === 0) {
            await this.redis.del(
              SocketsGateway.GET_USER_CONNECTIONS_KEY(client.user.steam_id),
            );
          }

          this.clients.delete(client.id);

          await this.sendPeopleOnline();
        });
      });
    });
  }

  private async broadcastMessage(event: string, data: unknown) {
    for (const client of Array.from(this.clients.values())) {
      client.send(
        JSON.stringify({
          event,
          data,
        }),
      );
    }
  }

  private async sendMessageToClient(
    steamId: string,
    event: string,
    data: unknown,
  ) {
    const clients = await this.redis.smembers(
      SocketsGateway.GET_CLIENT_CLIENTS_LIST_KEY(steamId),
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

  public async sendPeopleOnline() {
    const players = await this.redis.keys("user:*");

    await this.redis.publish(
      `broadcast-message`,
      JSON.stringify({
        event: `players-online`,
        data: players.map((player) => player.slice(5)),
      }),
    );
  }

  private async cleanClients(steamId: string) {
    const clients = await this.redis.smembers(
      SocketsGateway.GET_CLIENT_CLIENTS_LIST_KEY(steamId),
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
        SocketsGateway.GET_CLIENT_CLIENTS_LIST_KEY(steamId),
        client,
      );
    }
  }

  private async setupNode() {
    await this.redis.sadd(
      SocketsGateway.GET_AVAILABLE_NODES_KEY(),
      this.nodeId,
    );
    const markOnline = async () => {
      await this.redis.set(
        SocketsGateway.GET_NODE_STATUS_KEY(this.nodeId),
        "true",
        "EX",
        60,
      );
    };

    // await markOnline();
    // setInterval(async () => {
    //   await markOnline();
    // }, 30 * 1000);
  }
}
