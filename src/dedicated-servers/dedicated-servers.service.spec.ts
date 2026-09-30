import { DedicatedServersService } from "./dedicated-servers.service";

// Remove-then-create is not atomic. Two overlapping rebuilds of one server used
// to interleave: both removed, one created, and the other's AlreadyExists
// handler deleted the deployment the first had just created.
describe("DedicatedServersService.rebuildDedicatedServer", () => {
  const redis = { set: jest.fn() };
  const service = new DedicatedServersService(
    { log: jest.fn(), error: jest.fn(), verbose: jest.fn() } as never,
    { get: () => ({ namespace: "5stack" }) } as never,
    null as never,
    null as never,
    null as never,
    { getConnection: () => redis } as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  const steps: Array<string> = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  beforeEach(() => {
    steps.length = 0;
    redis.set.mockClear();

    jest
      .spyOn(service, "removeDedicatedServer")
      .mockImplementation(async (serverId: string) => {
        steps.push(`remove ${serverId}`);
        await tick();
      });
    jest
      .spyOn(service, "setupDedicatedServer")
      .mockImplementation(async (serverId: string) => {
        steps.push(`setup ${serverId}`);
        await tick();
        steps.push(`created ${serverId}`);
        return true;
      });
  });

  it("runs overlapping rebuilds of one server one after the other", async () => {
    await Promise.all([
      service.rebuildDedicatedServer("a"),
      service.rebuildDedicatedServer("a"),
    ]);

    expect(steps).toEqual([
      "remove a",
      "setup a",
      "created a",
      "remove a",
      "setup a",
      "created a",
    ]);
  });

  it("does not hold up a different server", async () => {
    await Promise.all([
      service.rebuildDedicatedServer("a"),
      service.rebuildDedicatedServer("b"),
    ]);

    expect(steps.slice(0, 2)).toEqual(["remove a", "remove b"]);
  });

  it("only removes when the server should not start", async () => {
    await service.rebuildDedicatedServer("a", false);

    expect(steps).toEqual(["remove a"]);
  });

  it("gives a server that will start again time to boot", async () => {
    await service.rebuildDedicatedServer("a");

    expect(redis.set).toHaveBeenCalledWith(
      "dedicated-servers:restarting:a",
      "1",
      "PX",
      5 * 60 * 1000,
    );
  });

  it("gives no boot time to a server being taken down", async () => {
    await service.rebuildDedicatedServer("a", false);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it("keeps going after a rebuild that failed", async () => {
    jest
      .spyOn(service, "setupDedicatedServer")
      .mockRejectedValueOnce(new Error("boom"));

    const [first, second] = await Promise.allSettled([
      service.rebuildDedicatedServer("a"),
      service.rebuildDedicatedServer("a"),
    ]);

    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: true });
  });
});

class FakeRedis {
  private values = new Map<string, { value: string; expiresAt?: number }>();
  private hashes = new Map<string, Map<string, string>>();
  public now = Date.now();

  async set(key: string, value: string, mode?: string, ms?: number) {
    this.values.set(key, {
      value,
      expiresAt: mode === "PX" ? this.now + ms : undefined,
    });
    return "OK";
  }

  async pttl(key: string) {
    const entry = this.values.get(key);
    if (!entry || (entry.expiresAt && entry.expiresAt <= this.now)) {
      return -2;
    }
    return entry.expiresAt ? entry.expiresAt - this.now : -1;
  }

  private hash(key: string) {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map());
    }
    return this.hashes.get(key);
  }

  async hsetnx(key: string, field: string, value: string) {
    if (this.hash(key).has(field)) {
      return 0;
    }
    this.hash(key).set(field, value);
    return 1;
  }

  async hset(key: string, field: string, value: string) {
    this.hash(key).set(field, value);
    return 1;
  }

  async hget(key: string, field: string) {
    return this.hash(key).get(field) ?? null;
  }

  async hdel(key: string, field: string) {
    return this.hash(key).delete(field) ? 1 : 0;
  }

  async expire() {
    return 1;
  }
}

describe("DedicatedServersService.pingDedicatedServer", () => {
  let redis: FakeRedis;
  let row: Record<string, unknown>;
  let reachable: boolean;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifications: { send: jest.Mock };
  let service: DedicatedServersService;

  beforeEach(() => {
    redis = new FakeRedis();
    reachable = true;
    row = {
      game: "cs2",
      label: "Retakes #1",
      enabled: true,
      connected: true,
      steam_relay: null,
      game_server_node_id: "node-1",
      server_region: { steam_relay: false },
    };
    hasura = {
      query: jest.fn(async () => ({ servers_by_pk: { ...row } })),
      mutation: jest.fn(async (mutation: Record<string, any>) => {
        Object.assign(row, mutation.update_servers_by_pk?.__args._set ?? {});
        return {};
      }),
    };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    const rcon = {
      connect: jest.fn(async () =>
        reachable
          ? {
              send: async () =>
                JSON.stringify({
                  server: {
                    steamid: null,
                    clients_human: 3,
                    map: "de_inferno",
                  },
                }),
            }
          : null,
      ),
      disconnect: jest.fn(),
    };

    service = new DedicatedServersService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      { get: () => ({ namespace: "5stack" }) } as never,
      hasura as never,
      null as never,
      rcon as never,
      { getConnection: () => redis } as never,
      { restartDeployment: jest.fn() } as never,
      null as never,
      null as never,
      null as never,
      notifications as never,
    );
  });

  const minutes = (count: number) => {
    redis.now += count * 60 * 1000;
    jest.setSystemTime(redis.now);
  };

  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate"] });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.setSystemTime(redis.now);
  });

  const alerts = () => notifications.send.mock.calls.length;

  it("does not mark an unreachable server connected", async () => {
    row.connected = false;
    reachable = false;

    await service.pingDedicatedServer("server-1");

    expect(row.connected).toBe(false);
  });

  it("marks a reachable server connected", async () => {
    row.connected = false;

    await service.pingDedicatedServer("server-1");

    expect(row.connected).toBe(true);
  });

  it("stays quiet about a server that just stopped answering", async () => {
    reachable = false;

    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");

    expect(alerts()).toBe(0);
    expect(row.connected).toBe(true);
  });

  it("reports a server unreachable for two minutes, once", async () => {
    reachable = false;

    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");

    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledWith(
      "DedicatedServerRconStatus",
      expect.objectContaining({ title: "Dedicated Server RCON Error" }),
      undefined,
      expect.any(Number),
    );
    expect(row.connected).toBe(false);
  });

  it("starts over once the server answers again", async () => {
    reachable = false;
    await service.pingDedicatedServer("server-1");
    minutes(1);
    reachable = true;
    await service.pingDedicatedServer("server-1");
    minutes(1);
    reachable = false;
    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");

    expect(alerts()).toBe(0);
  });

  it("waits out a restart before reporting", async () => {
    await service.restartDedicatedServer("server-1");
    reachable = false;

    for (let minute = 0; minute < 5; minute++) {
      await service.pingDedicatedServer("server-1");
      minutes(1);
    }
    expect(alerts()).toBe(0);

    await service.pingDedicatedServer("server-1");
    expect(alerts()).toBe(1);
  });

  it("never reports a disabled external server", async () => {
    row.enabled = false;
    row.game_server_node_id = null;
    reachable = false;

    for (let minute = 0; minute < 4; minute++) {
      await service.pingDedicatedServer("server-1");
      minutes(1);
    }

    expect(alerts()).toBe(0);
  });

  it("starts the clock over after a gap in pings", async () => {
    reachable = false;

    await service.pingDedicatedServer("server-1");
    minutes(5);
    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");
    expect(alerts()).toBe(0);

    minutes(1);
    await service.pingDedicatedServer("server-1");
    expect(alerts()).toBe(1);
  });

  it("tries the alert again when sending it failed", async () => {
    reachable = false;
    notifications.send.mockRejectedValueOnce(new Error("discord down"));

    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");
    minutes(1);
    await expect(service.pingDedicatedServer("server-1")).rejects.toThrow(
      "discord down",
    );
    minutes(1);
    await service.pingDedicatedServer("server-1");
    minutes(1);
    await service.pingDedicatedServer("server-1");

    expect(alerts()).toBe(2);
  });

  it("forgets the streak of a server that is removed", async () => {
    (service as any).apps = { deleteNamespacedDeployment: jest.fn() };
    reachable = false;

    await service.pingDedicatedServer("server-1");
    await service.removeDedicatedServer("server-1");

    expect(
      await redis.hget("dedicated-servers:unreachable", "server-1"),
    ).toBeNull();
  });
});

describe("DedicatedServersService.pluginInstallEnvironment", () => {
  const installs = (type: string, game = "cs2") =>
    Object.fromEntries(
      DedicatedServersService.pluginInstallEnvironment({ type, game }).map(
        ({ name, value }) => [name, value],
      ),
    );

  it("gives a Ranked server only the match plugin", () => {
    expect(installs("Ranked")).toEqual({
      INSTALL_5STACK_PLUGIN: "true",
      INSTALL_UTILITY_PRACTICE_PLUGIN: "false",
      INSTALL_PLAYER_MANAGEMENT_PLUGIN: "false",
    });
  });

  it("gives a Practice server only the utility plugin", () => {
    expect(installs("Practice")).toEqual({
      INSTALL_5STACK_PLUGIN: "false",
      INSTALL_UTILITY_PRACTICE_PLUGIN: "true",
      INSTALL_PLAYER_MANAGEMENT_PLUGIN: "false",
    });
  });

  it.each(["Competitive", "Casual", "Wingman", "Deathmatch", "Custom"])(
    "gives a %s community server the player management plugin",
    (type) => {
      expect(installs(type)).toEqual({
        INSTALL_5STACK_PLUGIN: "false",
        INSTALL_UTILITY_PRACTICE_PLUGIN: "false",
        INSTALL_PLAYER_MANAGEMENT_PLUGIN: "true",
      });
    },
  );

  it("never gives a CS:GO server the CS2-only player management plugin", () => {
    expect(installs("Casual", "csgo").INSTALL_PLAYER_MANAGEMENT_PLUGIN).toBe(
      "false",
    );
  });
});
