import "reflect-metadata";
import { SystemModule } from "./system.module";

describe("SystemModule update checks", () => {
  const originalRunMigrations = process.env.RUN_MIGRATIONS;

  const queue = () => ({
    add: jest.fn().mockResolvedValue({}),
    upsertJobScheduler: jest.fn().mockResolvedValue({}),
    getJobSchedulers: jest.fn().mockResolvedValue([]),
    removeJobScheduler: jest.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    delete process.env.RUN_MIGRATIONS;
  });

  afterEach(() => {
    if (originalRunMigrations !== undefined) {
      process.env.RUN_MIGRATIONS = originalRunMigrations;
    }
  });

  it("checks again when an update's old pod goes", async () => {
    let podGone: () => void = () => {};
    const versions = queue();

    new SystemModule(
      versions as any,
      {
        watchServicePods: (callback: () => void) => {
          podGone = callback;
        },
        getSetting: jest.fn().mockResolvedValue(60),
      } as any,
      { updateChatMessageTTL: jest.fn() } as any,
    );
    versions.add.mockClear();

    podGone();
    await new Promise((resolve) => setImmediate(resolve));

    expect(versions.add).toHaveBeenCalledWith(
      "CheckSystemUpdateJob",
      {},
      expect.objectContaining({ removeOnComplete: true }),
    );
  });

  it("gives every pod a rollout deletes in the same few seconds one check", async () => {
    const versions = queue();
    const now = 1_700_000_001_000;

    await SystemModule.checkSoon(versions as any, now);
    await SystemModule.checkSoon(versions as any, now + 2_000);

    const [[, , first], [, , second]] = versions.add.mock.calls;
    expect(first.jobId).toBe(second.jobId);
    expect(first.delay).toBeGreaterThan(0);
    expect(first.delay).toBeLessThanOrEqual(5_000);
  });

  it("never shares an id with a check that is already running", async () => {
    const versions = queue();
    const now = 1_700_000_004_900;

    await SystemModule.checkSoon(versions as any, now);

    const [[, , opts]] = versions.add.mock.calls;
    expect(opts.jobId).not.toBe(
      `CheckSystemUpdateJob.pods.${Math.floor(now / 5_000)}`,
    );
  });
});
