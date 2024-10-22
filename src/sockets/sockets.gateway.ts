import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
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

  public static GET_AVAILABLE_NODES_KEY() {
    return `available-socket-nodes`;
  }

  public static GET_NODE_STATUS_KEY(nodeId: string) {
    return `socket-node:${nodeId}:status`;
  }

  public static GET_PLAYER_KEY(steamId: string) {
    return `players:${steamId}`;
  }

  public static GET_PLAYER_CLIENTS(steamId: string) {
    return `clients:${steamId}`;
  }

  public static GET_PLAYER_CLIENTS_BY_NODE(steamId: string, nodeId: string) {
    return `${SocketsGateway.GET_PLAYER_CLIENTS(steamId)}:${nodeId}`;
  }

  public static GET_PLAYER_CLIENT(
    steamId: string,
    nodeId: string,
    clientId: string,
  ) {
    return `${SocketsGateway.GET_PLAYER_CLIENTS_BY_NODE(steamId, nodeId)}:${clientId}`;
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

  @SubscribeMessage("ping")
  public async handleMessage(client: FiveStackWebSocketClient): Promise<void> {
    await this.updateClient(client.user.steam_id, client.id);
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

        this.clients.set(client.id, client);

        await this.updateClient(client.user.steam_id, client.id);

        await this.sendPeopleOnline();
        await this.matchMaking.sendRegionStats(client.user);
        await this.matchMaking.sendQueueDetailsToUser(client.user.steam_id);

        client.on("close", async () => {
          await this.redis.del(
            SocketsGateway.GET_PLAYER_CLIENT(
              client.user.steam_id,
              this.nodeId,
              client.id,
            ),
          );

          const clients = await this.redis.keys(
            `${SocketsGateway.GET_PLAYER_CLIENTS(client.user.steam_id)}:*`,
          );

          if (clients.length === 0) {
            await this.redis.del(
              SocketsGateway.GET_PLAYER_KEY(client.user.steam_id),
            );
            await this.sendPeopleOnline();
          }
        });
      });
    });
  }

  private async updateClient(steamId: string, clientId: string) {
    await this.redis.set(
      SocketsGateway.GET_PLAYER_KEY(steamId),
      JSON.stringify({ lastSeen: Date.now() }),
      "EX",
      20,
    );

    await this.redis.set(
      SocketsGateway.GET_PLAYER_CLIENT(steamId, this.nodeId, clientId),
      "1",
      "EX",
      20,
    );
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
    const clients = await this.redis.keys(
      `${SocketsGateway.GET_PLAYER_CLIENTS_BY_NODE(steamId, this.nodeId)}:*`,
    );
    for (const client of clients) {
      const [, , clientId] = client.split(":");

      const _client = this.getClient(clientId);

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
    const players = await this.redis.keys("players:*");

    await this.redis.publish(
      `broadcast-message`,
      JSON.stringify({
        event: `players-online`,
        data: players.map((player) => {
          return player.slice(8);
        }),
      }),
    );
  }

  private getClient(clientId: string) {
    const _client = this.clients.get(clientId);

    if (_client) {
      return _client;
    }

    this.clients.delete(clientId);
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
