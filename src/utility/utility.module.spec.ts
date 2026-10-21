import "reflect-metadata";

jest.mock("sharp", () => ({ __esModule: true, default: () => ({}) }), {
  virtual: true,
});

import { UtilityModule } from "./utility.module";
import { UtilityJobs } from "./enums/UtilityJobs";

describe("UtilityModule boot", () => {
  const originalRunMigrations = process.env.RUN_MIGRATIONS;

  const queue = (schedulers: Array<{ key: string }> = []) => ({
    add: jest.fn().mockResolvedValue({}),
    upsertJobScheduler: jest.fn().mockResolvedValue({}),
    getJobSchedulers: jest.fn().mockResolvedValue(schedulers),
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

  const boot = (meta: ReturnType<typeof queue>) =>
    new UtilityModule(
      queue() as any,
      meta as any,
      queue() as any,
      { reconcileQueued: jest.fn().mockResolvedValue(undefined) } as any,
      { reconcile: jest.fn().mockResolvedValue(undefined) } as any,
    );

  it("leaves map callouts alone until a node reports a new CS2 build", async () => {
    const leftover = "f7b1c1d0a5e2d3c4b5a6978877665544";
    const meta = queue([
      { key: UtilityJobs.MineUtilityMeta },
      { key: leftover },
    ]);

    boot(meta);
    await new Promise((resolve) => setImmediate(resolve));

    expect(meta.upsertJobScheduler.mock.calls.map(([name]) => name)).toEqual([
      UtilityJobs.MineUtilityMeta,
    ]);
    expect(meta.removeJobScheduler).toHaveBeenCalledWith(leftover);
    expect(meta.removeJobScheduler).not.toHaveBeenCalledWith(
      UtilityJobs.MineUtilityMeta,
    );
  });
});
