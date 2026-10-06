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

    controller = new GameServerNodeController(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      hasura as any,
      {} as any,
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

  // Plugins from before the flag existed never send it.
  it("reads a plugin that does not say as awake", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: server(true) });

    await ping({});

    expect(hasura.mutation).toHaveBeenCalledWith(setsHibernating(false));
  });
});
