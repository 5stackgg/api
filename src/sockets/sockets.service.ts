import { v4 as uuidv4 } from "uuid";
import { Request, Response } from "express";
import session from "express-session";
import { getCookieOptions } from "../utilities/getCookieOptions";
import RedisStore from "connect-redis";
import passport from "passport";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { AppConfig } from "src/configs/types/AppConfig";
import { Redis } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { FiveStackWebSocketClient } from "./types/FiveStackWebSocketClient";
import { MatchmakeService } from "src/matchmaking/matchmake.service";
import { MatchmakingLobbyService } from "src/matchmaking/matchmaking-lobby.service";
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { DemoSessionWatcherService } from "src/matches/game-streamer/demo-session-watcher.service";
import { presenceFocusKey } from "src/notifications/push/notification-delivery";
import { HasuraService } from "src/hasura/hasura.service";

@Injectable()
export class SocketsService implements OnModuleInit, OnApplicationShutdown {
  private redis: Redis;
  private appConfig: AppConfig;
  private lastPeopleOnline?: string;
  private nodeId: string = process.env.POD_NAME;

  private clients: Map<string, FiveStackWebSocketClient> = new Map();

  // Delivery and the close handler read this rather than the clients:*
  // presence keys, which only say a socket pinged lately somewhere.
  private clientsBySteamId: Map<string, Set<string>> = new Map();

  // A tab hidden for a few minutes pings once a minute, so presence has to
  // outlast a missed ping or a hidden tab drops out of it.
  private static readonly PRESENCE_TTL_SECONDS = 150;

  // A pod that dies leaves its clients:* keys behind for the whole presence
  // TTL, so they only count while its own short-lived key says it is up.
  private static readonly POD_TTL_SECONDS = 20;
  private static readonly POD_HEARTBEAT_MS = 10 * 1000;

  // A tab's own ping slows to once a minute while it is hidden and stops
  // altogether while the browser freezes the page, but the browser still
  // answers a protocol ping for it. Only a socket that has gone quiet is asked.
  private static readonly QUIET_AFTER_MS = 30 * 1000;

  private podTimer: NodeJS.Timeout;

  // Twice the client's ping interval, so a focus survives a missed heartbeat
  // but a closed laptop stops claiming to be reading anything within a round.
  private static readonly FOCUS_TTL_SECONDS = 40;

  private static readonly AUTH_TIMEOUT_MS = 10 * 1000;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly matchmaking: MatchmakeService,
    private readonly redisManager: RedisManagerService,
    private readonly matchmakingLobbyService: MatchmakingLobbyService,
    @Inject("GAME_SERVER_NODE_CLIENT_SERVICE")
    private readonly gameServerNodeClient: ClientProxy,
    private readonly demoSessionWatcher: DemoSessionWatcherService,
    private readonly hasura: HasuraService,
  ) {
    this.redis = this.redisManager.getConnection();
    this.appConfig = this.config.get<AppConfig>("app");

    const sub = this.redisManager.getConnection("sub");

    void sub.subscribe("broadcast-message");
    void sub.subscribe("send-message-to-steam-id");
    sub.on("message", (channel, message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch (error) {
        // A malformed payload on the pub/sub channel must not take the pod
        // down: this handler runs outside any request lifecycle, so a throw
        // here is an uncaught exception.
        this.logger.error(
          `failed to parse pub/sub message on ${channel}: ${
            (error as Error)?.message
          }`,
        );
        return;
      }

      // JSON.parse succeeds for non-objects too (e.g. the literal `null`, which
      // typeof-reports as "object"); guard before destructuring so a valid but
      // non-object payload can't throw a TypeError here.
      if (parsed === null || typeof parsed !== "object") {
        this.logger.error(`ignoring non-object pub/sub message on ${channel}`);
        return;
      }

      const { steamId, event, data } = parsed as {
        steamId: string;
        event: string;
        data: unknown;
      };

      switch (channel) {
        case "broadcast-message":
          if (event === "players-online") {
            this.lastPeopleOnline = JSON.stringify(data);
          }
          void this.broadcastMessage(event, data);
          break;
        case "send-message-to-steam-id":
          void this.sendMessageToSteamId(steamId, event, data);
          break;
      }
    });
  }

  public static GET_POD_KEY(nodeId: string) {
    return `sockets:pod:${nodeId}`;
  }

  // What the close handler and MarkPlayerOffline both mean by "still online":
  // a socket that pinged lately, on a pod that is still up.
  public static async hasLivePresence(redis: Redis, steamId: string) {
    const clients = await redis.keys(
      `${SocketsService.GET_PLAYER_CLIENTS(steamId)}:*`,
    );

    const nodeIds = new Set(clients.map((key) => key.split(":")[2]));

    for (const nodeId of nodeIds) {
      if (await redis.exists(SocketsService.GET_POD_KEY(nodeId))) {
        return true;
      }
    }

    return false;
  }

  public onModuleInit() {
    void this.tick();
    this.podTimer = setInterval(
      () => void this.tick(),
      SocketsService.POD_HEARTBEAT_MS,
    );
    this.podTimer.unref?.();
  }

  public onApplicationShutdown() {
    clearInterval(this.podTimer);
  }

  private async tick() {
    try {
      await this.redis.set(
        SocketsService.GET_POD_KEY(this.nodeId),
        "1",
        "EX",
        SocketsService.POD_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `unable to mark this pod alive: ${(error as Error)?.message}`,
      );
    }

    // A socket whose peer vanished without a close would otherwise stay open,
    // and keep its player online, for good.
    const now = Date.now();
    const silentSince = now - SocketsService.PRESENCE_TTL_SECONDS * 1000;
    const quietSince = now - SocketsService.QUIET_AFTER_MS;
    for (const client of Array.from(this.clients.values())) {
      if (client.lastSeenAt < silentSince) {
        client.terminate();
      } else if (
        client.lastSeenAt < quietSince &&
        client.readyState === client.OPEN
      ) {
        client.ping();
      }
    }
  }

  public static GET_PLAYER_KEY(steamId: string) {
    return `players:${steamId}`;
  }

  public static GET_PLAYER_CLIENTS(steamId: string) {
    return `clients:${steamId}`;
  }

  public static GET_PLAYER_CLIENTS_BY_NODE(steamId: string, nodeId: string) {
    return `${SocketsService.GET_PLAYER_CLIENTS(steamId)}:${nodeId}`;
  }

  public static GET_PLAYER_CLIENT(
    steamId: string,
    nodeId: string,
    clientId: string,
  ) {
    return `${SocketsService.GET_PLAYER_CLIENTS_BY_NODE(steamId, nodeId)}:${clientId}`;
  }

  public static GET_PLAYER_CLIENT_LATENCY_TEST(sessionId: string) {
    return `latency-test:${sessionId}`;
  }

  // What the player is actually looking at, as opposed to whether they hold a
  // socket.
  //
  // `players:{steamId}` only says a tab exists somewhere, and chat room
  // membership is worse still -- it tracks the widget's mount lifecycle, so it
  // stays true for anyone who merely visited a match page an hour ago. Neither
  // can answer "are they reading this conversation right now", which is the
  // only question worth asking before buzzing someone's phone.
  //
  // One field per client, because a player with the conversation open in a
  // pinned tab and a match page in another is focused on whichever is in front.
  // Per-field expiry rather than a key TTL for the same reason: a tab that dies
  // without closing cleanly must drop out on its own without taking the other
  // tabs' focus with it.
  public async setFocus(
    steamId: string,
    clientId: string,
    focus: string | null,
  ) {
    const key = presenceFocusKey(steamId);

    if (!focus) {
      await this.redis.hdel(key, clientId);
      return;
    }

    await this.redis.hset(key, clientId, focus);

    await this.redis.sendCommand(
      new Redis.Command("HEXPIRE", [
        key,
        SocketsService.FOCUS_TTL_SECONDS,
        "FIELDS",
        1,
        clientId,
      ]),
    );
  }

  // Handlers wait on this before they read client.user. It settles with no
  // I/O between the open check and the close listener, so a socket that closes
  // during setup is still cleaned up, and it never rejects.
  public async setupSocket(client: FiveStackWebSocketClient, request: Request) {
    if (!(await this.authenticate(request))) {
      client.terminate();
      return;
    }

    if (client.readyState !== client.OPEN) {
      return;
    }

    client.id = uuidv4();
    client.user = request.user;
    client.sessionId = request.session.id;
    client.node = this.nodeId;
    client.peerNodes = new Set();
    client.signalPeers = new Map();
    client.lastSeenAt = Date.now();

    this.clients.set(client.id, client);
    this.indexClient(client);

    client.on("pong", () => void this.answered(client));

    const registered = this.register(client);

    void registered.then(() => this.welcome(client));

    client.on("close", async () => {
      this.clients.delete(client.id);
      this.unindexClient(client);

      void this.demoSessionWatcher.clientClosed(client.id);

      for (const nodeId of client.peerNodes) {
        this.gameServerNodeClient.emit(`peer-close.${nodeId}`, {
          clientId: client.id,
        });
      }
      client.peerNodes.clear();

      // Registering marks the player online and cancels their offline job, so
      // it has to be done before this can mark them offline again.
      await registered;

      await this.redis.del(
        SocketsService.GET_PLAYER_CLIENT(
          client.user.steam_id,
          this.nodeId,
          client.id,
        ),
      );

      await this.setFocus(client.user.steam_id, client.id, null);

      if (this.clientsBySteamId.has(String(client.user.steam_id))) {
        return;
      }

      if (
        await SocketsService.hasLivePresence(this.redis, client.user.steam_id)
      ) {
        return;
      }

      // Queued before the player disappears from presence: a reload's new
      // socket that registers from here on cancels it, and any ping after the
      // DEL finds them gone and cancels it too.
      await this.matchmaking.markOffline(client.user.steam_id);

      await this.redis.del(SocketsService.GET_PLAYER_KEY(client.user.steam_id));

      await this.sendPeopleOnline();
    });
  }

  private async register(client: FiveStackWebSocketClient) {
    try {
      await this.updateClient(client.user.steam_id, client.id);

      await this.matchmaking.cancelOffline(client.user.steam_id);
    } catch (error) {
      this.logger.error(
        `unable to register web socket for ${client.user.steam_id}`,
        error,
      );
    }
  }

  private async welcome(client: FiveStackWebSocketClient) {
    try {
      if (!(await this.sendPeopleOnline())) {
        client.send(
          JSON.stringify({
            event: "players-online",
            data: await this.peopleOnline(),
          }),
        );
      }
      await this.matchmaking.sendRegionStats(client.user);
      await this.matchmakingLobbyService.sendQueueDetailsToPlayer(
        client.user.steam_id,
      );
    } catch (error) {
      this.logger.error(
        `unable to finish setting up web socket for ${client.user.steam_id}`,
        error,
      );
    }
  }

  // Messages wait on the session load, so a stalled one would hold every
  // message an unauthenticated socket sends in memory.
  private async authenticate(request: Request): Promise<boolean> {
    let timer: NodeJS.Timeout;
    try {
      await Promise.race([
        this.loadSession(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("web socket session load timed out")),
            SocketsService.AUTH_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.logger.warn(`web socket auth failed: ${(error as Error)?.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }

    return !!request.user;
  }

  // Neither middleware touches the response, which is what lets them load a
  // session for a websocket upgrade.
  private loadSession(request: Request) {
    return new Promise<void>((resolve, reject) => {
      session({
        rolling: true,
        resave: false,
        name: this.appConfig.name,
        saveUninitialized: false,
        secret: this.appConfig.encSecret,
        cookie: getCookieOptions(),
        store: new RedisStore({
          prefix: `${this.appConfig.name}:auth:`,
          client: this.redis,
        }),
      })(request, {} as Response, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }

        passport.session()(request, {} as Response, (error?: unknown) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    });
  }

  // A ping that finds the player gone from presence puts them back: another
  // pod can have marked them offline while this tab sat hidden.
  public async heartbeat(steamId: string, clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastSeenAt = Date.now();

      if (!(await this.refreshRole(client))) {
        return;
      }
    }

    await this.keepPresence(steamId, clientId);
  }

  // What keeps a backgrounded tab online: the browser answers for it without
  // running the page.
  private async answered(client: FiveStackWebSocketClient) {
    client.lastSeenAt = Date.now();

    if (!this.clients.has(client.id)) {
      return;
    }

    try {
      await this.keepPresence(client.user.steam_id, client.id);
    } catch (error) {
      this.logger.warn(`unable to keep ${client.user.steam_id} online`, error);
    }
  }

  private async keepPresence(steamId: string, clientId: string) {
    if (!(await this.updateClient(steamId, clientId))) {
      return;
    }

    await this.matchmaking.cancelOffline(steamId);
    await this.sendPeopleOnline();
  }

  // The socket keeps the user it was opened with, and the handlers on it check
  // that role, so a demotion has to reach an open tab too.
  private async refreshRole(client: FiveStackWebSocketClient) {
    let role: FiveStackWebSocketClient["user"]["role"] | undefined;
    try {
      role = await this.hasura.getPlayerRole(client.user.steam_id);
    } catch (error) {
      this.logger.warn(
        `unable to refresh the role of ${client.user.steam_id}`,
        error,
      );
      return true;
    }

    if (!role) {
      client.close();
      return false;
    }

    client.user.role = role;

    return true;
  }

  // Resolves true when the player had no presence left.
  public async updateClient(steamId: string, clientId: string) {
    const previous = await this.redis.set(
      SocketsService.GET_PLAYER_KEY(steamId),
      JSON.stringify({ lastSeen: Date.now() }),
      "EX",
      SocketsService.PRESENCE_TTL_SECONDS,
      "GET",
    );

    await this.redis.set(
      SocketsService.GET_PLAYER_CLIENT(steamId, this.nodeId, clientId),
      "1",
      "EX",
      SocketsService.PRESENCE_TTL_SECONDS,
    );

    return previous === null;
  }

  // Every client on this pod. Callers almost always want every client
  // *everywhere* -- see broadcastToCluster. This stays public because the
  // pub/sub subscriber above is what turns a cluster broadcast into these
  // local sends on each pod.
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

  // Every client on every pod. A direct broadcastMessage call reaches only the
  // sockets attached to whichever pod happens to run the code, which on a
  // multi-pod deployment silently drops the message for most of the users it
  // was meant for.
  public async broadcastToCluster(event: string, data: unknown) {
    await this.redis.publish(
      "broadcast-message",
      JSON.stringify({ event, data }),
    );
  }

  public async sendMessageToClient(
    clientId: string,
    event: string,
    data: unknown,
  ) {
    const client = this.clients.get(clientId);

    if (!client) {
      return;
    }

    client.send(JSON.stringify({ event, data }));
  }

  private indexClient(client: FiveStackWebSocketClient) {
    const steamId = String(client.user.steam_id);

    let clientIds = this.clientsBySteamId.get(steamId);
    if (!clientIds) {
      clientIds = new Set();
      this.clientsBySteamId.set(steamId, clientIds);
    }

    clientIds.add(client.id);
  }

  private unindexClient(client: FiveStackWebSocketClient) {
    const steamId = String(client.user.steam_id);

    const clientIds = this.clientsBySteamId.get(steamId);
    if (!clientIds) {
      return;
    }

    clientIds.delete(client.id);

    if (clientIds.size === 0) {
      this.clientsBySteamId.delete(steamId);
    }
  }

  private async sendMessageToSteamId(
    steamId: string,
    event: string,
    data: unknown,
  ) {
    const clientIds = this.clientsBySteamId.get(String(steamId));

    if (!clientIds) {
      return;
    }

    const message = JSON.stringify({ event, data });

    for (const clientId of clientIds) {
      this.clients.get(clientId)?.send(message);
    }
  }

  private async peopleOnline() {
    const players = await this.redis.keys("players:*");

    return players.map((player) => player.slice(8)).sort();
  }

  // Every open tab looks up the players a roster brings, so a roster no
  // different from the last one any pod broadcast is not sent again.
  public async sendPeopleOnline() {
    const data = await this.peopleOnline();
    const roster = JSON.stringify(data);

    if (roster === this.lastPeopleOnline) {
      return false;
    }

    await this.redis.publish(
      `broadcast-message`,
      JSON.stringify({
        event: `players-online`,
        data,
      }),
    );
    this.lastPeopleOnline = roster;

    return true;
  }
}
