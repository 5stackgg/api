import { DelayedError } from "bullmq";
import { SyncMapCallouts } from "./SyncMapCallouts";

describe("SyncMapCallouts", () => {
  const NOW = 1_800_000_000_000;

  let callouts: { hasPublished: jest.Mock; syncAll: jest.Mock };
  let job: SyncMapCallouts;

  const queued = (data: { buildId?: number }, age = 0) => ({
    data,
    timestamp: NOW - age,
    token: "token",
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    callouts = {
      hasPublished: jest.fn().mockResolvedValue(true),
      syncAll: jest.fn().mockResolvedValue({ maps: 1, callouts: 1 }),
    };
    job = new SyncMapCallouts({ error: jest.fn() } as any, callouts as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("syncs straight away when no build is named", async () => {
    await job.process(queued({}) as any);

    expect(callouts.hasPublished).not.toHaveBeenCalled();
    expect(callouts.syncAll).toHaveBeenCalledTimes(1);
  });

  it("waits until the build's map assets are published", async () => {
    callouts.hasPublished.mockResolvedValue(false);
    const pending = queued({ buildId: 25600000 });

    await expect(job.process(pending as any)).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(callouts.hasPublished).toHaveBeenCalledWith(25600000);
    expect(pending.moveToDelayed).toHaveBeenCalledWith(
      NOW + SyncMapCallouts.WAIT_INTERVAL_MS,
      "token",
    );
    expect(callouts.syncAll).not.toHaveBeenCalled();
  });

  it("syncs once the build is published", async () => {
    const ready = queued({ buildId: 25600000 });

    await job.process(ready as any);

    expect(ready.moveToDelayed).not.toHaveBeenCalled();
    expect(callouts.syncAll).toHaveBeenCalledTimes(1);
  });

  it("syncs whatever is published once it has waited long enough", async () => {
    callouts.hasPublished.mockResolvedValue(false);
    const stale = queued({ buildId: 25600000 }, SyncMapCallouts.MAX_WAIT_MS);

    await job.process(stale as any);

    expect(callouts.hasPublished).not.toHaveBeenCalled();
    expect(callouts.syncAll).toHaveBeenCalledTimes(1);
  });
});
