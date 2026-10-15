import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { PushNotificationsService } from "./../src/notifications/push/push-notifications.service";

// The claim is one Lua script; only a real redis says what SET NX and EXISTS
// answer inside it.
describe("mention push claims (redis)", () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let push: PushNotificationsService;

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    push = new PushNotificationsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { query: jest.fn() } as any,
      { get: jest.fn(() => ({})) } as any,
      { add: jest.fn() } as any,
      { getConnection: () => redis } as any,
    );
  }, 120_000);

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  it("takes each player once per sender, whatever room the tag is in", async () => {
    await expect(
      push.claimMentionPushes("sender-1", ["a", "b"], "@a @b in one room"),
    ).resolves.toEqual(["a", "b"]);
    await expect(
      push.claimMentionPushes("sender-1", ["a", "c"], "@a @c in another"),
    ).resolves.toEqual(["c"]);
    await expect(
      push.claimMentionPushes("sender-2", ["a"], "@a in another"),
    ).resolves.toEqual(["a"]);
  });

  it("holds a player for the cooldown", async () => {
    await push.claimMentionPushes("sender-1", ["a"], "@a hi");

    const ttl = await redis.ttl("notifications:mention:sender-1:a");

    expect(ttl).toBeGreaterThan(
      PushNotificationsService.MENTION_COOLDOWN_SECONDS - 5,
    );
    expect(ttl).toBeLessThanOrEqual(
      PushNotificationsService.MENTION_COOLDOWN_SECONDS,
    );
  });

  it("never takes the same text twice within the hour, even after the cooldown", async () => {
    await push.claimMentionPushes("sender-1", ["a"], "@a hi");
    await redis.del("notifications:mention:sender-1:a");

    await expect(
      push.claimMentionPushes("sender-1", ["a"], "@a hi"),
    ).resolves.toEqual([]);
    await expect(
      push.claimMentionPushes("sender-1", ["a"], "@a hello"),
    ).resolves.toEqual(["a"]);
  });

  it("does not start a cooldown for text it turned away", async () => {
    await push.claimMentionPushes("sender-1", ["a"], "@a hi");
    await redis.del("notifications:mention:sender-1:a");

    await push.claimMentionPushes("sender-1", ["a"], "@a hi");

    expect(await redis.exists("notifications:mention:sender-1:a")).toBe(0);
  });

  it("answers for every player in one call", async () => {
    await push.claimMentionPushes("sender-1", ["b"], "@b first");

    await expect(
      push.claimMentionPushes("sender-1", ["a", "b", "c"], "@a @b @c"),
    ).resolves.toEqual(["a", "c"]);
  });
});
