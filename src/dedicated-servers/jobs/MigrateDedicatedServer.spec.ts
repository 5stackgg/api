import { DelayedError } from "bullmq";
import { MigrateDedicatedServer } from "./MigrateDedicatedServer";

describe("MigrateDedicatedServer", () => {
  const job = () => ({
    data: { migrationId: "migration-1" },
    token: "token",
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  });

  it("comes back once the run it was redelivered over has gone quiet, instead of completing", async () => {
    const migrations = { run: jest.fn().mockResolvedValue(46_000) };
    const redelivered = job();
    const before = Date.now();

    await expect(
      new MigrateDedicatedServer(migrations as any).process(redelivered as any),
    ).rejects.toBeInstanceOf(DelayedError);

    const [[until, token]] = redelivered.moveToDelayed.mock.calls;
    expect(until).toBeGreaterThanOrEqual(before + 46_000);
    expect(token).toBe("token");
  });

  it("completes once the move has been handled", async () => {
    const migrations = { run: jest.fn().mockResolvedValue(undefined) };
    const handled = job();

    await expect(
      new MigrateDedicatedServer(migrations as any).process(handled as any),
    ).resolves.toBeUndefined();
    expect(handled.moveToDelayed).not.toHaveBeenCalled();
  });
});
