import { Logger } from "@nestjs/common";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { CacheService } from "../src/cache/cache.service";

/**
 * Who may release or refresh a lock is decided by what redis holds at that
 * instant, so these run against a real redis.
 */
describe("cache locks", () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let cache: CacheService;

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });
  }, 120_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
    cache = new CacheService(
      { getConnection: () => redis } as any,
      new Logger("CacheLocksTest"),
    );
  });

  // A lock's time running out, without waiting for it.
  const runOut = (key: string) => redis.del(key);

  it("does not release a lock someone took after the holder's ran out", async () => {
    let finishSecond: () => void;
    let second: Promise<unknown>;

    await cache.lock("match:1", async () => {
      await runOut("lock:match:1");

      await new Promise<void>((held) => {
        second = cache.lock("match:1", () => {
          held();
          return new Promise((finish) => {
            finishSecond = () => finish(true);
          });
        });
      });

      return true;
    });

    expect(await redis.exists("lock:match:1")).toBe(1);

    finishSecond();
    await second;

    expect(await redis.exists("lock:match:1")).toBe(0);
  });

  it("is released only by the token it was taken with", async () => {
    const first = await cache.acquireLock("solve:1", 60);

    expect(first).toEqual(expect.any(String));
    expect(await cache.acquireLock("solve:1", 60)).toBeNull();

    await runOut("solve:1");
    const second = await cache.acquireLock("solve:1", 60);

    expect(await cache.releaseLock("solve:1", first)).toBe(false);
    expect(await redis.get("solve:1")).toBe(second);

    expect(await cache.releaseLock("solve:1", second)).toBe(true);
    expect(await redis.exists("solve:1")).toBe(0);
  });

  it("is refreshed only by the token it was taken with", async () => {
    const first = await cache.acquireLock("run", 5);

    expect(await cache.refreshLock("run", first, 600)).toBe(true);
    expect(await redis.ttl("run")).toBeGreaterThan(5);

    await runOut("run");
    await cache.acquireLock("run", 5);

    expect(await cache.refreshLock("run", first, 600)).toBe(false);
    expect(await redis.ttl("run")).toBeLessThanOrEqual(5);
  });

  it("is taken with the token it is given", async () => {
    expect(await cache.acquireLock("reindex", 60, "job:1")).toBe("job:1");
    expect(await cache.acquireLock("reindex", 60, "job:1")).toBeNull();
    expect(await cache.refreshLock("reindex", "job:1", 60)).toBe(true);
  });

  it("allows up to the limit in a window and opens again once it ends", async () => {
    expect(await cache.consume("imports", 20, 30, 60_000)).toBe(true);
    expect(await cache.consume("imports", 10, 30, 60_000)).toBe(true);
    expect(await cache.consume("imports", 1, 30, 60_000)).toBe(false);
    expect(await redis.pttl("imports")).toBeGreaterThan(0);

    await redis.del("imports");

    expect(await cache.consume("imports", 1, 30, 60_000)).toBe(true);
  });

  it("hands back a refused amount so it does not use up the window", async () => {
    expect(await cache.consume("imports", 25, 30, 60_000)).toBe(true);
    expect(await cache.consume("imports", 10, 30, 60_000)).toBe(false);

    expect(await cache.consume("imports", 5, 30, 60_000)).toBe(true);
    expect(await redis.get("imports")).toBe("30");
  });
});
