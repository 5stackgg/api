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

// RCON does not reach a hibernating server, so its own ping is answered instead.
describe("GameServerNodeController server ping reply", () => {
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let cache: { put: jest.Mock; forget: jest.Mock };
  let controller: GameServerNodeController;

  const server = (currentMatchId: string | null) => ({
    plugin_version: "1.0.0",
    plugin_runtime: "swiftlys2",
    connected: true,
    enabled: true,
    steam_relay: null as null,
    is_dedicated: true,
    game_server_node_id: null as null,
    current_match: currentMatchId
      ? {
          id: currentMatchId,
          current_match_map_id: null as null,
          match_maps: [] as unknown[],
        }
      : null,
  });

  const ping = (query: Record<string, string>) =>
    controller.ping({
      params: { serverId: "server-1" },
      query: { map: "de_overpass", pluginVersion: "1.0.0", ...query },
    } as any);

  beforeEach(() => {
    hasura = {
      query: jest.fn(),
      mutation: jest.fn().mockResolvedValue({}),
    };
    cache = { put: jest.fn(), forget: jest.fn() };
    const queue = { add: jest.fn(), remove: jest.fn() };

    controller = new GameServerNodeController(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      hasura as any,
      cache as any,
      {} as any,
      {} as any,
      {} as any,
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

  it("tells a server with nothing loaded that a match is waiting", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server("match-1") });

    expect(await ping({ matchId: "", hibernating: "true" })).toEqual({
      get_match: true,
    });
  });

  it("has nothing to say once the server has that match loaded", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server("match-1") });

    expect(await ping({ matchId: "match-1" })).toEqual({ get_match: false });
  });

  it("has nothing to say to an idle server with no match", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(null) });

    expect(await ping({ matchId: "" })).toEqual({ get_match: false });
  });

  it("tells a server to drop a match it no longer has", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(null) });

    expect(await ping({ matchId: "match-1" })).toEqual({ get_match: true });
  });

  it("never asks a plugin that does not name its match", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server("match-1") });

    expect(await ping({})).toEqual({ get_match: false });
  });

  it("remembers a hibernating server only for as long as it says so", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(null) });

    await ping({ hibernating: "true" });
    expect(cache.put).toHaveBeenCalledWith(
      "server:server-1:hibernating",
      true,
      expect.any(Number),
    );

    await ping({ hibernating: "false" });
    expect(cache.forget).toHaveBeenCalledWith("server:server-1:hibernating");
  });
});
