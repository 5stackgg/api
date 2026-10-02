import "reflect-metadata";

jest.mock("sharp", () => ({ __esModule: true, default: () => ({}) }), {
  virtual: true,
});

import { UtilityModule } from "./utility.module";
import { UtilityJobs } from "./enums/UtilityJobs";

describe("UtilityModule boot", () => {
  const originalRunMigrations = process.env.RUN_MIGRATIONS;

  const queue = () => ({
    add: jest.fn().mockResolvedValue({}),
    removeRepeatable: jest.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    delete process.env.RUN_MIGRATIONS;
  });

  afterEach(() => {
    if (originalRunMigrations !== undefined) {
      process.env.RUN_MIGRATIONS = originalRunMigrations;
    }
  });

  it("leaves map callouts alone until a node reports a new CS2 build", () => {
    const meta = queue();

    new UtilityModule(
      queue() as any,
      meta as any,
      queue() as any,
      { reconcileQueued: jest.fn().mockResolvedValue(undefined) } as any,
    );

    expect(meta.add.mock.calls.map(([name]) => name)).not.toContain(
      UtilityJobs.SyncMapCallouts,
    );
    expect(meta.removeRepeatable).toHaveBeenCalledWith(
      UtilityJobs.SyncMapCallouts,
      { pattern: "23 4 * * *" },
    );
  });
});
