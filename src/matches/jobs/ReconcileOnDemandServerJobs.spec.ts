jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { ReconcileOnDemandServerJobs } from "./ReconcileOnDemandServerJobs";

describe("ReconcileOnDemandServerJobs", () => {
  let matchAssistant: { reconcileOnDemandServerJobs: jest.Mock };
  let logger: { error: jest.Mock };
  let processor: ReconcileOnDemandServerJobs;

  beforeEach(() => {
    matchAssistant = { reconcileOnDemandServerJobs: jest.fn() };
    logger = { error: jest.fn() };
    processor = new ReconcileOnDemandServerJobs(
      logger as any,
      matchAssistant as any,
    );
  });

  it("runs the sweep", async () => {
    await processor.process();

    expect(matchAssistant.reconcileOnDemandServerJobs).toHaveBeenCalledTimes(1);
  });

  // A repeatable job: the next tick is the retry.
  it("logs a failed sweep instead of failing the repeatable job", async () => {
    matchAssistant.reconcileOnDemandServerJobs.mockRejectedValue(
      new Error("hasura unavailable"),
    );

    await expect(processor.process()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
