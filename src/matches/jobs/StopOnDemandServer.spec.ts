jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

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
      removeUnstoppedOnDemandServer: jest.fn(),
    };
    processor = new StopOnDemandServer(matchAssistant as any);
  });

  it("stops the match's server", async () => {
    await processor.process({ data: { matchId: "match-1" } } as any);

    expect(matchAssistant.stopEndedMatchServer).toHaveBeenCalledWith("match-1");
    expect(matchAssistant.removeUnstoppedOnDemandServer).not.toHaveBeenCalled();
  });

  it("checks back on a server it already signalled", async () => {
    await processor.process({
      data: { matchId: "match-1", jobUid: "uid-1" },
    } as any);

    expect(matchAssistant.removeUnstoppedOnDemandServer).toHaveBeenCalledWith(
      "match-1",
      "uid-1",
    );
    expect(matchAssistant.stopEndedMatchServer).not.toHaveBeenCalled();
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
