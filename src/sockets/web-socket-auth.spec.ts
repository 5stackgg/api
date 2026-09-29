import { SocketsGateway } from "./sockets.gateway";
import { ChatGateway } from "src/chat/chat.gateway";
import { RconGateway } from "src/rcon/rcon.gateway";
import { DemoSessionWatcherGateway } from "src/matches/game-streamer/demo-session-watcher.gateway";
import { MatchmakingGateway } from "src/matchmaking/matchmaking.gateway";
import { SystemGateway } from "src/system/system.gateway.ts";
import { VoiceGateway } from "src/voice/voice.gateway";
import { SignalServerGateway } from "src/signal-server/signal-server.gateway";
import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import {
  GATEWAY_OPTIONS,
  MESSAGE_METADATA,
} from "@nestjs/websockets/constants";

const USER = {
  steam_id: "76561198000000001",
  name: "Luke",
  role: "administrator",
};

function harness() {
  const calls: string[] = [];

  const dependency = (
    name: string,
    overrides: Record<string, unknown> = {},
  ): any =>
    new Proxy(overrides, {
      get: (target, property) => {
        if (property in target) {
          return target[property as string];
        }
        if (typeof property === "symbol" || property === "then") {
          return undefined;
        }
        return (..._args: unknown[]) => {
          calls.push(`${name}.${property}`);
          return dependency(`${name}.${property}()`);
        };
      },
    });

  let finish: (user: typeof USER | null) => void;

  const sockets = dependency("sockets", {
    setupSocket: (client: any) =>
      new Promise<void>((resolve) => {
        finish = (user) => {
          if (user) {
            client.id = "client-1";
            client.user = user;
            client.sessionId = "session-1";
            client.peerNodes = new Set();
            client.signalPeers = new Map();
          }
          resolve();
        };
      }),
  });

  const logger = dependency("logger");
  const hasura = dependency("hasura", {
    query: async () => {
      calls.push("hasura.query");
      return {
        settings: [] as unknown[],
        server_regions: [] as unknown[],
        game_server_nodes: [{ id: "node-1" }],
        game_server_nodes_aggregate: { aggregate: { count: 0 } },
      };
    },
  });

  const socketsGateway = new SocketsGateway(sockets);
  const gateways = {
    sockets: socketsGateway,
    chat: new ChatGateway(dependency("chat")),
    rcon: new RconGateway(dependency("rcon")),
    demo: new DemoSessionWatcherGateway(
      logger,
      dependency("watcher"),
      dependency("gameStreamer"),
    ),
    matchmaking: new MatchmakingGateway(
      logger,
      hasura,
      dependency("redisManager"),
      dependency("matchmake"),
      dependency("matchmakingLobby"),
      dependency("cache"),
    ),
    system: new SystemGateway(logger, dependency("logging")),
    voice: new VoiceGateway(logger, dependency("voice")),
    signal: new SignalServerGateway(hasura, dependency("gameServerNode")),
  };

  calls.length = 0;

  const socket = () =>
    ({
      readyState: 1,
      OPEN: 1,
      send: jest.fn(),
      terminate: jest.fn(),
      close: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    }) as any;

  const connect = (client: any) => {
    void socketsGateway.handleConnection(client, {} as any);
  };

  return {
    calls,
    gateways,
    socket,
    connect,
    finish: (user: typeof USER | null) => finish(user),
  };
}

type Gateways = ReturnType<typeof harness>["gateways"];

const lobby = { id: "match-1", type: ChatLobbyType.Match };

const handlers: Array<
  [string, (g: Gateways, client: any) => Promise<unknown>]
> = [
  ["ping", (g, c) => g.sockets.handleMessage(c)],
  [
    "presence",
    (g, c) => g.sockets.handlePresence({ visible: true, focus: "x" }, c),
  ],
  ["lobby:join", (g, c) => g.chat.joinLobby(lobby, c)],
  ["lobby:leave", (g, c) => g.chat.leaveLobby(lobby, c)],
  ["lobby:read", (g, c) => g.chat.markRead(lobby, c)],
  ["lobby:chat", (g, c) => g.chat.lobby({ ...lobby, message: "hi" }, c)],
  [
    "lobby:delete",
    (g, c) => g.chat.deleteMessage({ ...lobby, messageId: "m-1" }, c),
  ],
  [
    "lobby:edit",
    (g, c) =>
      g.chat.editMessage({ ...lobby, messageId: "m-1", message: "hi" }, c),
  ],
  [
    "lobby:react",
    (g, c) =>
      g.chat.react({ ...lobby, messageId: "m-1", reaction: "heart" }, c),
  ],
  [
    "rcon",
    (g, c) =>
      g.rcon.rconEvent({ uuid: "u", command: "status", serverId: "s" }, c),
  ],
  [
    "demo-session:watch",
    (g, c) => g.demo.onWatch(c, { match_map_id: "map-1" }),
  ],
  [
    "demo-session:unwatch",
    async (g, c) => g.demo.onUnwatch(c, { match_map_id: "map-1" }),
  ],
  [
    "demo-session:control",
    (g, c) => g.demo.onControl(c, { match_map_id: "map-1", action: "pause" }),
  ],
  [
    "matchmaking:join-queue",
    (g, c) =>
      g.matchmaking.joinQueue(
        { type: "Competitive" as any, regions: ["US"] },
        c,
      ),
  ],
  ["matchmaking:leave", (g, c) => g.matchmaking.leaveQueue(c)],
  [
    "matchmaking:confirm",
    (g, c) => g.matchmaking.playerConfirmation({ confirmationId: "x" }, c),
  ],
  ["logs", (g, c) => g.system.logEvent({ service: "api" }, c)],
  [
    "voice:device-claim",
    (g, c) =>
      g.voice.deviceClaim({ channelId: "c", kind: "mic", claimed: true }, c),
  ],
  [
    "voice:speaking",
    (g, c) => g.voice.speaking({ channelId: "c", speaking: true }, c),
  ],
  [
    "offer",
    (g, c) =>
      g.signal.handleOffer(
        { region: "US", peerId: "peer-1", signal: {} as any },
        c,
      ),
  ],
  [
    "candidate",
    async (g, c) => {
      await Promise.all([
        g.signal.handleOffer(
          { region: "US", peerId: "peer-1", signal: {} as any },
          c,
        ),
        g.signal.handleIceCandidate(
          { region: "US", peerId: "peer-1", signal: {} as any },
          c,
        ),
      ]);
    },
  ],
];

const settle = () => new Promise((resolve) => setImmediate(resolve));

const outcome = (handled: Promise<unknown>) =>
  handled.then(
    () => "resolved",
    (error: Error) => `rejected: ${error.message}`,
  );

describe("/ws/web handlers and socket auth", () => {
  it("covers every message handler on the /ws/web gateways", () => {
    const events = Object.values(harness().gateways).flatMap((gateway) => {
      const prototype = Object.getPrototypeOf(gateway);
      expect(
        Reflect.getMetadata(GATEWAY_OPTIONS, prototype.constructor)?.path,
      ).toBe("/ws/web");
      return Object.getOwnPropertyNames(prototype)
        .map((name) => Reflect.getMetadata(MESSAGE_METADATA, prototype[name]))
        .filter(Boolean);
    });

    expect(events.sort()).toEqual(handlers.map(([event]) => event).sort());
  });

  describe.each(handlers)("%s", (_, invoke) => {
    it("refuses messages sent while auth is pending once it fails, and after", async () => {
      const { calls, gateways, socket, connect, finish } = harness();
      const client = socket();

      connect(client);
      const raced = outcome(invoke(gateways, client));

      finish(null);
      await raced;
      const after = await outcome(invoke(gateways, client));

      expect(calls).toEqual([]);
      expect(await raced).toBe("resolved");
      expect(after).toBe("resolved");
    });

    it("holds messages sent while auth is pending and handles them once it succeeds", async () => {
      const { calls, gateways, socket, connect, finish } = harness();
      const client = socket();

      connect(client);
      const early = invoke(gateways, client).catch((): void => undefined);

      await settle();
      expect(calls).toEqual([]);

      finish(USER);
      await early;

      expect(calls).not.toEqual([]);
    });

    it("refuses a socket that never authenticated", async () => {
      const { calls, gateways, socket } = harness();

      const result = await outcome(invoke(gateways, socket()));

      expect(calls).toEqual([]);
      expect(result).toBe("resolved");
    });
  });
});
