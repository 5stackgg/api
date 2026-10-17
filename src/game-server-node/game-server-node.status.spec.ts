jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
}));

import { GameServerNodeService } from "./game-server-node.service";

// The panel's CS2 column, and whether an unforced update thinks a node is
// current, both come from build_id. It is only ever written from what the
// node's connector reports, so a node whose install vanished must stop
// reporting the build it used to have.
describe("GameServerNodeService.updateStatus — installed CS2 build", () => {
  const NODE_ID = "dietpi";
  const BUILD = 25966348;
  const cpuInfo = { sockets: 1, coresPerSocket: 4, threadsPerCore: 1 };
  const cpuGovernorInfo = { governor: "performance", cpus: {} };
  const cpuFrequencyInfo = { cpus: {}, frequency: 3600 };

  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let service: GameServerNodeService;

  const stored = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    token: null,
    status: "Online",
    label: "CA1",
    offline_at: null,
    lan_ip: "192.168.2.199",
    node_ip: "100.117.134.62",
    build_id: null,
    csgo_build_id: null,
    public_ip: "174.89.125.136",
    gpu: false,
    gpu_info: null,
    cpu_sockets: cpuInfo.sockets,
    cpu_cores_per_socket: cpuInfo.coresPerSocket,
    cpu_threads_per_core: cpuInfo.threadsPerCore,
    supports_low_latency: true,
    supports_cpu_pinning: true,
    cpu_governor_info: cpuGovernorInfo,
    cpu_frequency_info: cpuFrequencyInfo,
    cpu_warnings: [],
    update_status: null,
    enabled: true,
    enabled_for_match_making: true,
    servers: [],
    ...overrides,
  });

  const heartbeat = (csBuild: number | undefined) =>
    service.updateStatus(
      NODE_ID,
      "100.117.134.62",
      "192.168.2.199",
      "174.89.125.136",
      csBuild,
      undefined,
      true,
      true,
      cpuInfo,
      cpuGovernorInfo,
      cpuFrequencyInfo,
      undefined,
      "Online" as any,
      undefined,
      [],
    );

  const writtenBuilds = () =>
    hasura.mutation.mock.calls
      .map(([mutation]) => mutation.update_game_server_nodes_by_pk?.__args._set)
      .filter(Boolean)
      .map((set) => ("build_id" in set ? set.build_id : "untouched"));

  beforeEach(() => {
    hasura = { query: jest.fn(), mutation: jest.fn().mockResolvedValue({}) };
    service = new GameServerNodeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: () => ({ namespace: "5stack" }) } as any,
      hasura as any,
      { getConnection: () => ({}) } as any,
      {} as any,
      {} as any,
      {} as any,
      {
        queueBuild: jest.fn().mockResolvedValue(undefined),
        queueCalloutsSync: jest.fn().mockResolvedValue(undefined),
      } as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
    );
    jest
      .spyOn(service as any, "queueGamedataValidation")
      .mockResolvedValue(true);
  });

  it("clears the build once the install is gone", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({ build_id: BUILD }),
    });
    await heartbeat(undefined);
    expect(writtenBuilds()).toEqual([null]);
  });

  it("leaves the build alone while an update has the install torn down", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({
        build_id: BUILD,
        update_status: "Downloading",
      }),
    });
    await heartbeat(undefined);
    expect(writtenBuilds()).not.toContain(null);
  });

  it("writes nothing for a node that has never had CS2", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({ build_id: null }),
    });
    await heartbeat(undefined);
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("records a build the connector reports", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({ build_id: null }),
    });
    await heartbeat(BUILD);
    expect(writtenBuilds()).toEqual([BUILD]);
  });
});
