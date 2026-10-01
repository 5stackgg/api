import { GameServerNodeController } from "./game-server-node.controller";
import { CleanupRemovedNode } from "./jobs/CleanupRemovedNode";
import { CleanupRemovedNodesOutput } from "./node-cleanup.service";

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

describe("GameServerNodeController removed node cleanup", () => {
  let nodeCleanup: { cleanupRemovedNodes: jest.Mock };
  let nodeOfflineQueue: { add: jest.Mock; remove: jest.Mock };
  let controller: GameServerNodeController;

  const result = (counts: Partial<CleanupRemovedNodesOutput> = {}) => ({
    nodes: 0,
    jobs: 0,
    volume_claims: 0,
    volumes: 0,
    failed: 0,
    node_delete_forbidden: false,
    recently_ready: 0,
    ...counts,
  });

  const removed = (old: Record<string, unknown>) =>
    controller.game_server_node_removed({
      op: "DELETE",
      old,
      new: {},
    } as any);

  beforeEach(() => {
    nodeCleanup = {
      cleanupRemovedNodes: jest.fn().mockResolvedValue(result()),
    };
    nodeOfflineQueue = {
      add: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(1),
    };

    controller = new GameServerNodeController(
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      nodeOfflineQueue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      nodeCleanup as any,
    );
  });

  it("queues a retried cleanup of the deleted row's node instead of cleaning inline", async () => {
    await expect(removed({ id: "node-1" })).resolves.toBeUndefined();

    expect(nodeOfflineQueue.add).toHaveBeenCalledTimes(1);
    expect(nodeOfflineQueue.add).toHaveBeenCalledWith(
      CleanupRemovedNode.name,
      { nodeId: "node-1" },
      {
        attempts: 6,
        backoff: { type: "exponential", delay: 10 * 1000 },
        removeOnFail: false,
        removeOnComplete: true,
        jobId: "node-cleanup.node-1",
      },
    );

    // HasuraController swallows handler errors, so the job does the cleanup
    expect(nodeCleanup.cleanupRemovedNodes).not.toHaveBeenCalled();
  });

  it("removes an earlier cleanup job of the node before queueing, since a taken job id makes the add a no-op", async () => {
    await removed({ id: "node-1" });

    expect(nodeOfflineQueue.remove).toHaveBeenCalledWith("node-cleanup.node-1");
    expect(nodeOfflineQueue.remove.mock.invocationCallOrder[0]).toBeLessThan(
      nodeOfflineQueue.add.mock.invocationCallOrder[0],
    );
  });

  it("queues a job of its own when the earlier cleanup of the node is running, since a running job cannot be removed", async () => {
    nodeOfflineQueue.remove.mockResolvedValue(0);

    await removed({ id: "node-1" });

    expect(nodeOfflineQueue.add).toHaveBeenCalledWith(
      CleanupRemovedNode.name,
      { nodeId: "node-1" },
      expect.objectContaining({
        jobId: expect.stringMatching(/^node-cleanup\.node-1\.\d+$/),
      }),
    );
  });

  it("ignores an event without the id of the deleted row", async () => {
    await expect(removed({})).resolves.toBeUndefined();

    expect(nodeOfflineQueue.remove).not.toHaveBeenCalled();
    expect(nodeOfflineQueue.add).not.toHaveBeenCalled();
    expect(nodeCleanup.cleanupRemovedNodes).not.toHaveBeenCalled();
  });

  it("returns the sweep result from the admin action", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({ nodes: 2, failed: 1, node_delete_forbidden: true }),
    );

    // HasuraController binds the action input the way it does here, and that
    // input must never be taken for a node id
    const action = (controller as any).cleanupRemovedNodes.bind(controller, {
      user: { role: "administrator" },
      session: {},
    });

    await expect(action()).resolves.toEqual(
      result({ nodes: 2, failed: 1, node_delete_forbidden: true }),
    );

    expect(nodeCleanup.cleanupRemovedNodes).toHaveBeenCalledWith();
  });
});
