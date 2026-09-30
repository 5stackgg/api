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
