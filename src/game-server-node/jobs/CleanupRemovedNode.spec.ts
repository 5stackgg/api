import { DelayedError } from "bullmq";
import { CleanupRemovedNode } from "./CleanupRemovedNode";
import {
  CleanupRemovedNodesOutput,
  NodeCleanupService,
} from "../node-cleanup.service";

describe("CleanupRemovedNode", () => {
  let nodeCleanup: { cleanupRemovedNodes: jest.Mock };
  let logger: { warn: jest.Mock };
  let job: CleanupRemovedNode;

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

  const queueJob = (data: { nodeId: string; readyChecks?: number }) => ({
    data,
    token: "token-1",
    updateData: jest.fn().mockResolvedValue(undefined),
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  });

  const run = (queued = queueJob({ nodeId: "node-1" })) =>
    job.process(queued as any);

  beforeEach(() => {
    nodeCleanup = {
      cleanupRemovedNodes: jest.fn().mockResolvedValue(result()),
    };
    logger = { warn: jest.fn() };
    job = new CleanupRemovedNode(logger as any, nodeCleanup as any);
  });

  it("cleans up only the removed node", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({ nodes: 1, jobs: 2, volume_claims: 4, volumes: 4 }),
    );

    await expect(run()).resolves.toBeUndefined();

    expect(nodeCleanup.cleanupRemovedNodes).toHaveBeenCalledTimes(1);
    expect(nodeCleanup.cleanupRemovedNodes).toHaveBeenCalledWith("node-1");
  });

  it("throws when a delete failed, so the queue retries the cleanup", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({ jobs: 1, failed: 2 }),
    );

    await expect(run()).rejects.toThrow(
      "unable to clean up removed node node-1: 2 delete(s) failed",
    );
  });

  it("rethrows when the cluster could not be read, so the queue retries the cleanup", async () => {
    nodeCleanup.cleanupRemovedNodes.mockRejectedValue(
      new Error("unable to list cluster objects"),
    );

    await expect(run()).rejects.toThrow("unable to list cluster objects");
  });

  it("succeeds when the node registered again and nothing was deleted", async () => {
    // the service skips an id whose row is back
    await expect(run()).resolves.toBeUndefined();
  });

  it("does not retry a Node delete the RBAC forbids, since retries cannot fix it", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({
        jobs: 2,
        volume_claims: 1,
        volumes: 1,
        node_delete_forbidden: true,
      }),
    );

    await expect(run()).resolves.toBeUndefined();
  });

  it("checks a recently Ready node again later, without failing the job", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({ recently_ready: 1 }),
    );
    const queued = queueJob({ nodeId: "node-1", readyChecks: 2 });

    await expect(run(queued)).rejects.toBeInstanceOf(DelayedError);

    expect(queued.updateData).toHaveBeenCalledWith({
      nodeId: "node-1",
      readyChecks: 3,
    });
    expect(queued.moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      "token-1",
    );
    const [delayedUntil] = queued.moveToDelayed.mock.calls[0];
    expect(delayedUntil - Date.now()).toBeGreaterThan(
      CleanupRemovedNode.READY_CHECK_DELAY_MS - 5000,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps checking for twice the NotReady grace of the service", () => {
    expect(
      CleanupRemovedNode.READY_CHECKS * CleanupRemovedNode.READY_CHECK_DELAY_MS,
    ).toBeGreaterThanOrEqual(2 * NodeCleanupService.NOT_READY_GRACE_MS);
  });

  it("still runs the last check before giving up", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({ recently_ready: 1 }),
    );
    const queued = queueJob({
      nodeId: "node-1",
      readyChecks: CleanupRemovedNode.READY_CHECKS - 1,
    });

    await expect(run(queued)).rejects.toBeInstanceOf(DelayedError);

    expect(queued.updateData).toHaveBeenCalledWith({
      nodeId: "node-1",
      readyChecks: CleanupRemovedNode.READY_CHECKS,
    });
    expect(queued.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("gives up quietly once the node stayed recently Ready for every check", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({ recently_ready: 1 }),
    );
    const queued = queueJob({
      nodeId: "node-1",
      readyChecks: CleanupRemovedNode.READY_CHECKS,
    });

    await expect(run(queued)).resolves.toBeUndefined();

    expect(queued.moveToDelayed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "node-1 is still Ready or went NotReady too recently",
      ),
    );
  });

  it("retries failed deletes before checking the Ready state", async () => {
    nodeCleanup.cleanupRemovedNodes.mockResolvedValue(
      result({ failed: 1, recently_ready: 1 }),
    );
    const queued = queueJob({ nodeId: "node-1" });

    await expect(run(queued)).rejects.toThrow("1 delete(s) failed");

    expect(queued.moveToDelayed).not.toHaveBeenCalled();
  });
});
