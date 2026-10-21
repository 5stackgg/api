import { Logger } from "@nestjs/common";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { DedicatedServersService } from "../src/dedicated-servers/dedicated-servers.service";

/**
 * Whether a server gets an RCON ping each minute is decided by a hash field
 * expiring in redis, so these run against a real redis.
 */
describe("dedicated server plugin reports", () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let service: DedicatedServersService;

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
    service = new DedicatedServersService(
      new Logger("PluginReportsTest"),
      { get: () => ({ namespace: "5stack" }) } as any,
      {} as any,
      {} as any,
      {} as any,
      { getConnection: () => redis } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it("lists a server's players and level from its plugin, as the RCON ping did", async () => {
    await DedicatedServersService.recordPluginReport(redis, "server-1", {
      players: 7,
      map: "de_overpass",
    });

    expect(await service.getAllDedicatedServerStats()).toEqual([
      expect.objectContaining({
        id: "server-1",
        players: 7,
        map: "de_overpass",
      }),
    ]);
  });

  it("takes a reporting server out of the RCON ping, and only that one", async () => {
    await DedicatedServersService.recordPluginReport(redis, "server-1", {
      players: 0,
      map: "de_inferno",
    });

    expect(
      await service.pluginReportedServers(["server-1", "server-2"]),
    ).toEqual(new Set(["server-1"]));
  });

  it("puts a server back on the RCON ping within a minute of its plugin going quiet", async () => {
    await DedicatedServersService.recordPluginReport(redis, "server-1", {
      players: 3,
      map: "de_nuke",
    });

    const [ttl] = (await redis.call(
      "HTTL",
      "dedicated-servers:plugin-reported",
      "FIELDS",
      "1",
      "server-1",
    )) as Array<number>;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    await redis.call(
      "HPEXPIRE",
      "dedicated-servers:plugin-reported",
      "1",
      "FIELDS",
      "1",
      "server-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await service.pluginReportedServers(["server-1"])).toEqual(
      new Set(),
    );
  });
});
