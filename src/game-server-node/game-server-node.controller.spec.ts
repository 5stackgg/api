import { INestApplication, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HasuraService } from "../hasura/hasura.service";
import { GameServerNodeController } from "./game-server-node.controller";

describe("GameServerNodeController ping disk alerts", () => {
  let gameServerNodeService: { updateStatus: jest.Mock };
  let notifications: { send: jest.Mock };
  let controller: GameServerNodeController;

  beforeEach(() => {
    gameServerNodeService = { updateStatus: jest.fn() };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    const queue = { add: jest.fn(), remove: jest.fn() };

    controller = new GameServerNodeController(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      { mutation: jest.fn().mockResolvedValue({}) } as any,
      {
        remember: jest.fn().mockResolvedValue([
          { name: "disk_warning_percent", value: "75" },
          { name: "disk_critical_percent", value: "90" },
        ]),
      } as any,
      {} as any,
      {} as any,
      gameServerNodeService as any,
      notifications as any,
      {} as any,
      queue as any,
      queue as any,
      {} as any,
      queue as any,
      queue as any,
      {} as any,
      {} as any,
    );
  });

  const ping = () =>
    controller.handleMessage({
      node: "node-1",
      labels: { "5stack-id": "1", "5stack-network-limiter": "1" },
      nodeStats: {
        cpuInfo: { sockets: 1, coresPerSocket: 8, threadsPerCore: 2 },
        disks: [{ mountpoint: "/", usedPercent: "95", available: "1" }],
      },
    } as any);

  it("raises a disk alert for a node in service", async () => {
    gameServerNodeService.updateStatus.mockResolvedValue({ inService: true });

    await ping();

    expect(notifications.send).toHaveBeenCalledWith(
      "GameNodeStatus",
      expect.objectContaining({
        title: "Game Server Node Disk Space Critical",
      }),
      undefined,
      expect.any(Number),
      false,
    );
  });

  it("raises no disk alert for a disabled node", async () => {
    gameServerNodeService.updateStatus.mockResolvedValue({ inService: false });

    await ping();

    expect(notifications.send).not.toHaveBeenCalled();
  });
});

describe("GameServerNodeController server ping hibernation", () => {
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let reportSteamRelay: jest.Mock;
  let controller: GameServerNodeController;

  const server = (hibernating: boolean) => ({
    plugin_version: "1.0.0",
    plugin_runtime: "swiftlys2",
    connected: true,
    hibernating,
    enabled: true,
    steam_relay: null as null,
    is_dedicated: true,
    game_server_node_id: null as null,
    current_match: null as null,
  });

  const ping = (query: Record<string, string>) =>
    controller.ping({
      params: { serverId: "server-1" },
      query: { map: "de_overpass", pluginVersion: "1.0.0", ...query },
    } as any);

  const setsHibernating = (hibernating: boolean) =>
    expect.objectContaining({
      update_servers_by_pk: expect.objectContaining({
        __args: expect.objectContaining({ _set: { hibernating } }),
      }),
    });

  beforeEach(() => {
    hasura = {
      query: jest.fn(),
      mutation: jest.fn().mockResolvedValue({}),
    };
    const queue = { add: jest.fn(), remove: jest.fn() };
    reportSteamRelay = jest.fn().mockResolvedValue(true);

    controller = new GameServerNodeController(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      hasura as any,
      {} as any,
      {} as any,
      {} as any,
      { reportSteamRelay } as any,
      {} as any,
      {} as any,
      queue as any,
      queue as any,
      {} as any,
      queue as any,
      queue as any,
      {} as any,
      {} as any,
    );
  });

  it("records a server that says it is hibernating", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(false) });

    await ping({ hibernating: "true" });

    expect(hasura.mutation).toHaveBeenCalledWith(setsHibernating(true));
  });

  it("clears it once the server wakes", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(true) });

    await ping({ hibernating: "false" });

    expect(hasura.mutation).toHaveBeenCalledWith(setsHibernating(false));
  });

  it("writes nothing while the state has not changed", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(true) });

    await ping({ hibernating: "true" });

    expect(hasura.mutation).not.toHaveBeenCalledWith(setsHibernating(true));
    expect(hasura.mutation).not.toHaveBeenCalledWith(setsHibernating(false));
  });

  // The match plugin names the relay only when it is on it.
  it("takes the relay address the ping names as where the server is", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(false) });

    await ping({ steamRelay: "true", steamID: "[A:1:3653557264:51859]" });

    expect(reportSteamRelay).toHaveBeenCalledWith("server-1", {
      onRelay: true,
      address: "[A:1:3653557264:51859]",
    });
  });

  it("takes a ping that does not name the relay as a server off it", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(false) });

    await ping({});

    expect(reportSteamRelay).toHaveBeenCalledWith("server-1", {
      onRelay: false,
      address: null,
    });
  });

  it("does not call a server up that is on the relay with no address yet", async () => {
    hasura.query.mockResolvedValue({
      servers_by_pk: { ...server(false), connected: false },
    });

    await ping({ steamRelay: "true" });

    expect(reportSteamRelay).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  // Plugins from before the flag existed never send it.
  it("reads a plugin that does not say as awake", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(true) });

    await ping({});

    expect(hasura.mutation).toHaveBeenCalledWith(setsHibernating(false));
  });
});

// Asked over HTTP, because the status a refusal turns into is the thing under
// test: a refusal must look the same whether the node is unknown or the token
// is wrong.
describe("GameServerNodeController setup script", () => {
  const NODE_TOKEN = "tskey-node-setup-1234";
  let hasura: { query: jest.Mock };
  let app: INestApplication;

  const fetchScript = (query: Record<string, unknown>) =>
    request(app.getHttpServer())
      .get("/game-server-node/script/node-1.sh")
      .query(query);

  beforeEach(async () => {
    hasura = {
      query: jest.fn().mockResolvedValue({
        game_server_nodes_by_pk: { token: NODE_TOKEN },
        settings: [],
      }),
    };

    const module = await Test.createTestingModule({
      controllers: [GameServerNodeController],
    })
      .useMocker((token) => {
        if (token === HasuraService) {
          return hasura;
        }
        if (token === ConfigService) {
          return { get: jest.fn().mockReturnValue({}) };
        }
        if (token === Logger) {
          return { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
        }
        return {};
      })
      .compile();

    app = module.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves the script to the setup link's token", async () => {
    const response = await fetchScript({ token: NODE_TOKEN });

    expect(response.status).toBe(200);
    expect(response.text).toContain(NODE_TOKEN);
  });

  const notFound = async (query: Record<string, unknown>) => {
    const response = await fetchScript(query);

    expect(response.status).toBe(404);
    expect(response.text).not.toContain(NODE_TOKEN);
    return response.body;
  };

  const unknownNode = () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: null,
      settings: [],
    });
    return notFound({ token: NODE_TOKEN });
  };

  it("answers a node that does not exist with a 404", async () => {
    await unknownNode();
  });

  it.each([
    ["no token", {}],
    ["an empty token", { token: "" }],
    ["a wrong token", { token: "tskey-node-setup-9999" }],
    ["a token of another length", { token: `${NODE_TOKEN}0` }],
    ["a token repeated in the query", { token: [NODE_TOKEN, NODE_TOKEN] }],
    [
      "a token as long in characters but not bytes",
      { token: "é".repeat(NODE_TOKEN.length) },
    ],
  ])("answers %s like a node that does not exist", async (_, query) => {
    const refused = await notFound(query);

    expect(await unknownNode()).toEqual(refused);
  });

  it("answers for a node without a token like a node that does not exist", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: { token: null },
      settings: [],
    });
    const refused = await notFound({ token: NODE_TOKEN });

    expect(await unknownNode()).toEqual(refused);
  });
});
