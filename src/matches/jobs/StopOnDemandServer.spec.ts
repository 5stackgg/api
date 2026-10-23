jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { DelayedError } from "bullmq";
import { StopOnDemandServer } from "./StopOnDemandServer";

describe("StopOnDemandServer", () => {
  let matchAssistant: {
    stopEndedMatchServer: jest.Mock;
    removeUnstoppedOnDemandServer: jest.Mock;
  };
  let processor: StopOnDemandServer;

  beforeEach(() => {
    matchAssistant = {
      stopEndedMatchServer: jest.fn(),
      removeUnstoppedOnDemandServer: jest.fn(async () => true),
    };
    processor = new StopOnDemandServer(matchAssistant as any);
  });

  it("stops the match's server", async () => {
    await processor.process({ data: { matchId: "match-1" } } as any);

    expect(matchAssistant.stopEndedMatchServer).toHaveBeenCalledWith(
      "match-1",
      undefined,
    );
    expect(matchAssistant.removeUnstoppedOnDemandServer).not.toHaveBeenCalled();
  });

  it("tells the stop which server the match ended on", async () => {
    await processor.process({
      data: { matchId: "match-1", serverId: "server-1" },
    } as any);

    expect(matchAssistant.stopEndedMatchServer).toHaveBeenCalledWith(
      "match-1",
      "server-1",
    );
  });

  it("checks back on a server it already signalled", async () => {
    await processor.process({
      data: { matchId: "match-1", jobName: "u-match-1", jobUid: "uid-1" },
    } as any);

    expect(matchAssistant.removeUnstoppedOnDemandServer).toHaveBeenCalledWith(
      "match-1",
      "uid-1",
      "u-match-1",
      undefined,
      undefined,
    );
    expect(matchAssistant.stopEndedMatchServer).not.toHaveBeenCalled();
  });

  it("checks back again while the server it signalled is still exiting", async () => {
    matchAssistant.removeUnstoppedOnDemandServer.mockResolvedValue(false);
    const job = {
      data: {
        matchId: "match-1",
        jobName: "m-match-1",
        jobUid: "uid-1",
        signalledAt: 1000,
        serverId: "server-1",
      },
      token: "token-1",
      moveToDelayed: jest.fn(),
    };
    const before = Date.now();

    await expect(processor.process(job as any)).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(matchAssistant.removeUnstoppedOnDemandServer).toHaveBeenCalledWith(
      "match-1",
      "uid-1",
      "m-match-1",
      1000,
      "server-1",
    );
    const [[until, token]] = job.moveToDelayed.mock.calls;
    expect(token).toBe("token-1");
    expect(until - before).toBeGreaterThanOrEqual(3 * 1000);
    expect(until - before).toBeLessThan(5 * 1000);
  });

  it("fails the job when the teardown fails, so BullMQ retries it", async () => {
    matchAssistant.stopEndedMatchServer.mockRejectedValue(
      new Error("k8s down"),
    );

    await expect(
      processor.process({ data: { matchId: "match-1" } } as any),
    ).rejects.toThrow("k8s down");
  });
});
