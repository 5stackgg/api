import { DedicatedServersService } from "./dedicated-servers.service";
import { GameModesService } from "../game-plugins/game-modes.service";

// Remove-then-create is not atomic. Two overlapping rebuilds of one server used
// to interleave: both removed, one created, and the other's AlreadyExists
// handler deleted the deployment the first had just created.
describe("DedicatedServersService.rebuildDedicatedServer", () => {
  const redis = { set: jest.fn() };
  const postgres = { query: jest.fn() };
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
    postgres as never,
    null as never,
  );

  const steps: Array<string> = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  beforeEach(() => {
    steps.length = 0;
    redis.set.mockClear();
    postgres.query.mockReset().mockResolvedValue([]);

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

  it("takes a server down but does not start it while it is being moved", async () => {
    postgres.query.mockResolvedValue([{ "?column?": 1 }]);

    await expect(service.rebuildDedicatedServer("a")).resolves.toBe(true);

    expect(steps).toEqual(["remove a"]);
    expect(redis.set).not.toHaveBeenCalled();
    expect(postgres.query).toHaveBeenCalledWith(expect.any(String), [
      "a",
      ["Stopping", "Transferring"],
    ]);
  });

  it("does not ask about a move when the server is only being taken down", async () => {
    await service.rebuildDedicatedServer("a", false);

    expect(postgres.query).not.toHaveBeenCalled();
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
  let pluginCvars: { harvest: jest.Mock };
  let rcon: Record<string, jest.Mock>;
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
    pluginCvars = { harvest: jest.fn().mockResolvedValue(undefined) };
    rcon = {
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
      listCvars: jest.fn(async () => []),
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
      null as never,
      pluginCvars as never,
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

  it("reads plugin cvars over the open connection before closing it", async () => {
    const order: Array<string> = [];
    pluginCvars.harvest.mockImplementation(
      async (_: string, list: (name: string) => Promise<unknown>) => {
        await list("dm_replenish_health");
        order.push("harvest");
      },
    );
    rcon.disconnect.mockImplementation(async () => {
      order.push("disconnect");
    });

    await service.pingDedicatedServer("server-1");

    expect(rcon.listCvars).toHaveBeenCalledWith(
      "server-1",
      "dm_replenish_health",
    );
    expect(order).toEqual(["harvest", "disconnect"]);
  });

  it("tells the harvest a server that just came up has restarted", async () => {
    row.connected = false;

    await service.pingDedicatedServer("server-1");

    expect(pluginCvars.harvest).toHaveBeenCalledWith(
      "server-1",
      expect.any(Function),
      { restarted: true },
    );
  });

  it("does not ask an unreachable server about its plugins", async () => {
    reachable = false;

    await service.pingDedicatedServer("server-1");

    expect(pluginCvars.harvest).not.toHaveBeenCalled();
  });

  it("still marks the server connected when reading its cvars fails", async () => {
    row.connected = false;
    pluginCvars.harvest.mockRejectedValue(new Error("rcon dropped"));

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

describe("DedicatedServersService.getServerPlayerList", () => {
  const build = (connected: boolean) => {
    const rcon = {
      connect: jest.fn(async () => ({ send: async () => "{}" })),
      disconnect: jest.fn(),
    };
    const hasura = {
      query: jest.fn(async () => ({
        servers_by_pk: { game: "cs2", connected },
      })),
    };
    const service = new DedicatedServersService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      { get: () => ({ namespace: "5stack" }) } as never,
      hasura as never,
      null as never,
      rcon as never,
      { getConnection: () => null } as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    return { service, rcon };
  };

  it("never dials RCON on a server marked offline", async () => {
    const { service, rcon } = build(false);

    await expect(service.getServerPlayerList("server-1")).resolves.toEqual([]);
    expect(rcon.connect).not.toHaveBeenCalled();
  });

  it("reads the roster over RCON on a connected server", async () => {
    const { service, rcon } = build(true);

    await service.getServerPlayerList("server-1");

    expect(rcon.connect).toHaveBeenCalledWith("server-1");
    expect(rcon.disconnect).toHaveBeenCalledWith("server-1");
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

describe("DedicatedServersService.launchMode", () => {
  // The Deathmatch plugin patches Valve's deathmatch rules; on stock Custom
  // they never run and everyone spawns at their team's spawn.
  it("boots a custom mode on the Valve mode it names", () => {
    expect(DedicatedServersService.launchMode("Custom", "deathmatch")).toEqual([
      "+game_type 1",
      "+game_mode 2",
    ]);
  });

  it("keeps stock Custom when the mode names no Valve mode", () => {
    expect(DedicatedServersService.launchMode("Custom", null)).toEqual([
      "+game_type 3",
      "+game_mode 0",
    ]);
  });

  // CS:GO ran retakes as skirmish 12 on Custom. CS2 has no skirmishes and
  // lists retakes as classic game mode 5.
  it("boots a Retake server on CS2's retakes mode", () => {
    expect(DedicatedServersService.launchMode("Retake", null)).toEqual([
      "+game_type 0",
      "+game_mode 5",
    ]);
  });

  it.each([
    ["Ranked", "+game_type 0", "+game_mode 1"],
    ["Competitive", "+game_type 0", "+game_mode 1"],
    ["Casual", "+game_type 0", "+game_mode 0"],
    ["Wingman", "+game_type 0", "+game_mode 2"],
    ["Deathmatch", "+game_type 1", "+game_mode 2"],
    ["ArmsRace", "+game_type 1", "+game_mode 0"],
  ])("boots a %s server as %s %s", (type, gameType, gameMode) => {
    expect(DedicatedServersService.launchMode(type as never, null)).toEqual([
      gameType,
      gameMode,
    ]);
  });
});

describe("DedicatedServersService.withServerCfg", () => {
  const mode = (overrides: Record<string, unknown> = {}) => ({
    id: "mode-1",
    slug: "deathmatch",
    name: "Deathmatch",
    cfg: "mp_teammates_are_enemies 1",
    extraGameParams: null,
    valveMode: "deathmatch",
    enabledPlugins: "deathmatch@1.0.0",
    pluginConfigs: null as string | null,
    missingRequired: [] as Array<string>,
    disableServerGuidelines: false,
    workshopAddons: [] as Array<string>,
    ...overrides,
  });

  const files = (resolved: { pluginConfigs: string | null } | null) =>
    resolved?.pluginConfigs
      ? JSON.parse(Buffer.from(resolved.pluginConfigs, "base64").toString())
      : {};

  // A community server has no match, so nothing ever ran the mode's cvars
  // there. CS2 execs gamemode_<mode>_server.cfg after the Valve mode's own
  // config on every map load, which is also what keeps them after a map change.
  it("writes a mode's cvars where CS2 runs them after its Valve mode's config", () => {
    expect(
      files(DedicatedServersService.withServerCfg(mode(), "Custom" as never)),
    ).toEqual({
      "cfg/gamemode_deathmatch_server.cfg": "mp_teammates_are_enemies 1\n",
    });
  });

  it("uses stock Custom's hook for a mode that names no Valve mode", () => {
    expect(
      Object.keys(
        files(
          DedicatedServersService.withServerCfg(
            mode({ valveMode: null }),
            "Custom" as never,
          ),
        ),
      ),
    ).toEqual(["cfg/gamemode_custom_server.cfg"]);
  });

  it("keeps the plugin config files already headed to the server", () => {
    const pluginConfigs = Buffer.from(
      JSON.stringify({ "addons/swiftlys2/configs/dm.jsonc": "{}" }),
    ).toString("base64");

    expect(
      files(
        DedicatedServersService.withServerCfg(
          mode({ pluginConfigs }),
          "Custom" as never,
        ),
      ),
    ).toEqual({
      "addons/swiftlys2/configs/dm.jsonc": "{}",
      "cfg/gamemode_deathmatch_server.cfg": "mp_teammates_are_enemies 1\n",
    });
  });

  it("adds nothing for a mode without cvars", () => {
    expect(
      DedicatedServersService.withServerCfg(
        mode({ cfg: "  " }),
        "Custom" as never,
      )?.pluginConfigs,
    ).toBeNull();
  });

  // Rush runs a Valve map script and execs no server config of its own.
  it("adds nothing on Rush, which has no server config to run them from", () => {
    expect(
      DedicatedServersService.withServerCfg(
        mode({ valveMode: "rush" }),
        "Custom" as never,
      )?.pluginConfigs,
    ).toBeNull();
  });

  it("leaves a server with no mode alone", () => {
    expect(
      DedicatedServersService.withServerCfg(null, "Casual" as never),
    ).toBeNull();
  });

  // Same order a match execs them in: the mode's cvars win over a plugin's.
  it("runs each loading plugin's cvars ahead of the mode's", () => {
    expect(
      files(
        DedicatedServersService.withServerCfg(mode(), "Custom" as never, [
          { slug: "inventory", cfg: 'invsim_url "https://inv.example"' },
          { slug: "stats", cfg: "mp_teammates_are_enemies 0\n" },
        ]),
      ),
    ).toEqual({
      "cfg/gamemode_deathmatch_server.cfg":
        'invsim_url "https://inv.example"\nmp_teammates_are_enemies 0\nmp_teammates_are_enemies 1\n',
    });
  });

  // A server's own value for a plugin is the most specific, so it lands last.
  it("runs a server's own plugin cvars after the mode's", () => {
    expect(
      files(
        DedicatedServersService.withServerCfg(
          mode(),
          "Custom" as never,
          [{ slug: "deathmatch", cfg: "dm_replenish_health 10" }],
          [{ slug: "deathmatch", cfg: "dm_replenish_health 50" }],
        ),
      ),
    ).toEqual({
      "cfg/gamemode_deathmatch_server.cfg":
        "dm_replenish_health 10\nmp_teammates_are_enemies 1\ndm_replenish_health 50\n",
    });
  });

  it("writes plugin cvars on a server whose mode has none of its own", () => {
    expect(
      files(
        DedicatedServersService.withServerCfg(
          mode({ cfg: null, valveMode: null }),
          "Casual" as never,
          [{ slug: "inventory", cfg: "invsim_ws_enabled 1" }],
        ),
      ),
    ).toEqual({
      "cfg/gamemode_casual_server.cfg": "invsim_ws_enabled 1\n",
    });
  });
});

describe("DedicatedServersService.setupDedicatedServer", () => {
  const inventoryCfg = [
    'invsim_url "https://inventory.5stack.gg"',
    "invsim_ws_enabled 1",
  ].join("\n");

  const pluginsOnly = {
    id: "",
    slug: "",
    name: "",
    cfg: null,
    extraGameParams: null,
    valveMode: null,
    enabledPlugins: "inventory-simulator@1.0.0",
    pluginConfigs: null,
    missingRequired: [],
    disableServerGuidelines: false,
    workshopAddons: [] as Array<string>,
  };

  const deploy = async (type: string, game = "cs2") => {
    const createNamespacedDeployment = jest.fn().mockResolvedValue({});
    const gameModes = {
      resolveForServer: jest.fn().mockResolvedValue(pluginsOnly),
      pluginCfgLayers: jest
        .fn()
        .mockResolvedValue([
          { slug: "inventory-simulator", cfg: inventoryCfg },
        ]),
      serverCfgLayers: jest
        .fn()
        .mockResolvedValue([
          { slug: "inventory-simulator", cfg: "invsim_ws_enabled 0" },
        ]),
      environmentFor: GameModesService.prototype.environmentFor,
    };

    const service = new DedicatedServersService(
      { log: jest.fn(), verbose: jest.fn(), error: jest.fn() } as never,
      { get: () => ({ namespace: "5stack" }) } as never,
      {
        query: jest.fn().mockResolvedValue({
          servers_by_pk: {
            id: "server-1",
            type,
            port: 27015,
            tv_port: 27020,
            game,
            max_players: 10,
            api_password: "api",
            rcon_password: "rcon",
            connect_password: null,
            game_server_node: { id: "node-1" },
            server_region: { steam_relay: false },
          },
        }),
        mutation: jest.fn().mockResolvedValue({}),
      } as never,
      { decrypt: jest.fn().mockResolvedValue("rcon") } as never,
      null as never,
      { getConnection: () => ({}) } as never,
      null as never,
      {
        resolvePluginRuntime: jest.fn().mockResolvedValue("swiftly"),
        resolveGameServerPluginImage: jest.fn().mockResolvedValue("image"),
      } as never,
      gameModes as never,
      { forServer: jest.fn().mockResolvedValue({ maps: [] }) } as never,
      null as never,
      null as never,
      null as never,
    );

    Object.assign(service, { apps: { createNamespacedDeployment } });
    jest
      .spyOn(service as never, "waitForPodReady")
      .mockReturnValue(new Promise(() => {}) as never);

    expect(await service.setupDedicatedServer("server-1")).toBe(true);

    const env: Array<{ name: string; value: string }> =
      createNamespacedDeployment.mock.calls[0][0].body.spec.template.spec
        .containers[0].env;

    return env;
  };

  const setup = async (type: string) => {
    const env = await deploy(type);
    const pluginConfigs = env.find((entry) => entry.name === "PLUGIN_CONFIGS");

    return pluginConfigs
      ? JSON.parse(Buffer.from(pluginConfigs.value, "base64").toString())
      : {};
  };

  // The inventory plugin's configuration never reached a community server:
  // only a match execs plugin cvars, so it ran on the plugin's own defaults.
  it("gives a community server the cvars of the plugins it loads", async () => {
    expect(await setup("Casual")).toEqual({
      "cfg/gamemode_casual_server.cfg": `${inventoryCfg}\ninvsim_ws_enabled 0\n`,
    });
  });

  it("leaves them to the match on a Ranked server", async () => {
    expect(await setup("Ranked")).toEqual({});
  });

  const launchParams = async (type: string, game?: string) =>
    (await deploy(type, game))
      .find((entry) => entry.name === "EXTRA_GAME_PARAMS")
      .value.split(" ");

  it.each(["Casual", "Ranked", "Custom"])(
    "boots a CS2 %s server with workshop command filtering off",
    async (type) => {
      expect(await launchParams(type)).toContain(
        "-disable_workshop_command_filtering",
      );
    },
  );

  it("leaves the CS2-only flag off a CS:GO server", async () => {
    expect(await launchParams("Casual", "csgo")).not.toContain(
      "-disable_workshop_command_filtering",
    );
  });
});
