import IORedis, { Redis } from "ioredis";
import { Queue } from "bullmq";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { scheduleJobs } from "../src/utilities/QueueProcessors";

/**
 * What a queue ends up scheduled to run is whatever redis holds after every
 * boot, including the ones before this helper existed, so these run against a
 * real redis.
 */
describe("job schedulers", () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let queue: Queue;

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: null,
    });
  }, 120_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
    queue = new Queue("schedulers-spec", { connection: redis });
  });

  afterEach(async () => {
    await queue.close();
  });

  const schedules = async () =>
    (await queue.getJobSchedulers())
      .map(({ key, name, pattern, every }) => ({ key, name, pattern, every }))
      .sort((a, b) => a.key.localeCompare(b.key));

  const delayedNames = async () =>
    (await queue.getDelayed()).map((job) => job.name).sort();

  it("leaves both cadences running when the old repeat option changes pattern", async () => {
    await queue.add("Sweep", {}, { repeat: { pattern: "* * * * *" } });
    await queue.add("Sweep", {}, { repeat: { pattern: "*/10 * * * *" } });

    expect((await schedules()).map(({ pattern }) => pattern).sort()).toEqual([
      "* * * * *",
      "*/10 * * * *",
    ]);
  });

  it("replaces a schedule left by the old repeat option", async () => {
    await queue.add("Sweep", {}, { repeat: { pattern: "* * * * *" } });

    await scheduleJobs(queue, { Sweep: { pattern: "*/10 * * * *" } });

    expect(await schedules()).toEqual([
      {
        key: "Sweep",
        name: "Sweep",
        pattern: "*/10 * * * *",
        every: undefined,
      },
    ]);
    expect(await delayedNames()).toEqual(["Sweep"]);
  });

  it("changes a cadence in place on the next boot", async () => {
    await scheduleJobs(queue, { Sweep: { pattern: "* * * * *" } });
    await scheduleJobs(queue, { Sweep: { pattern: "*/10 * * * *" } });

    expect(await schedules()).toEqual([
      {
        key: "Sweep",
        name: "Sweep",
        pattern: "*/10 * * * *",
        every: undefined,
      },
    ]);
    expect(await delayedNames()).toEqual(["Sweep"]);
  });

  it("stops scheduling a job dropped from the list", async () => {
    await scheduleJobs(queue, {
      Sweep: { pattern: "* * * * *" },
      Poll: { every: 10_000 },
    });

    await scheduleJobs(queue, { Sweep: { pattern: "* * * * *" } });

    expect((await schedules()).map(({ key }) => key)).toEqual(["Sweep"]);
    expect(await delayedNames()).toEqual(["Sweep"]);
  });

  it("keeps the queue's one-off delayed jobs", async () => {
    await queue.add(
      "AutoPickExpiredVeto",
      { matchId: "1" },
      { jobId: "match.1.veto-pick.0", delay: 60_000 },
    );

    await scheduleJobs(queue, { Sweep: { pattern: "* * * * *" } });

    expect(await delayedNames()).toEqual(["AutoPickExpiredVeto", "Sweep"]);
  });

  it("names each run after its job, which is how the processor finds its class", async () => {
    await scheduleJobs(queue, { Sweep: { every: 10_000 } });

    const [run] = await queue.getJobs(["delayed", "wait"]);

    expect(run.name).toBe("Sweep");
  });
});
