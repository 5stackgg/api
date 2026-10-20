import "reflect-metadata";

import { GameServerNodeModule } from "./game-server-node.module";

describe("GameServerNodeModule boot", () => {
  const originalRunMigrations = process.env.RUN_MIGRATIONS;

  const queue = () => ({
    add: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue(1),
  });

  beforeEach(() => {
    delete process.env.RUN_MIGRATIONS;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalRunMigrations !== undefined) {
      process.env.RUN_MIGRATIONS = originalRunMigrations;
    }
  });

  it("boots while hasura is still refusing connections after a node reboot", async () => {
    const reconcileUpdateStatuses = jest.fn().mockResolvedValue(undefined);
    const logger = { warn: jest.fn() };

    const module = new GameServerNodeModule(
      queue() as any,
      {
        mutation: jest.fn().mockRejectedValue(
          new TypeError("fetch failed", {
            cause: new Error("connect ECONNREFUSED 10.43.55.58:8080"),
          }),
        ),
      } as any,
      { reconcileUpdateStatuses } as any,
      logger as any,
    );

    await expect(module.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(reconcileUpdateStatuses).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60 * 1000);
    expect(reconcileUpdateStatuses).toHaveBeenCalledTimes(2);
  });
});
