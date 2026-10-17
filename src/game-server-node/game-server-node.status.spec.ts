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
import { NodeDisk } from "./interfaces/NodeDisk";

// The panel's CS2 column, and whether an unforced update thinks a node is
// current, both come from build_id. It is only ever written from what the
// node's connector reports, so a node whose install vanished must stop
// reporting the build it used to have.
describe("GameServerNodeService.updateStatus", () => {
  const NODE_ID = "node-a";
  const BUILD = 25966348;
  const CSGO_BUILD = 7766;
  const NODE_IP = "100.64.0.10";
  const LAN_IP = "192.0.2.10";
  const PUBLIC_IP = "203.0.113.10";
  const cpuInfo = { sockets: 1, coresPerSocket: 4, threadsPerCore: 1 };
  const cpuGovernorInfo = { governor: "performance", cpus: {} };
  const cpuFrequencyInfo = { cpus: {}, frequency: 3600 };
  const disk = (availableGb: number, usedPercent: number): NodeDisk => ({
    filesystem: "/dev/sda1",
    size: String(200 * 1024 * 1024),
    used: "0",
    available: String(availableGb * 1024 * 1024),
    usedPercent: String(usedPercent),
    mountpoint: "/",
  });

  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let service: GameServerNodeService;

  const stored = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    token: null,
    status: "Online",
    label: "Node A",
    offline_at: null,
    lan_ip: LAN_IP,
    node_ip: NODE_IP,
    build_id: null,
    csgo_build_id: null,
    public_ip: PUBLIC_IP,
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
    disk_available_gb: 100,
    disk_used_percent: 50,
    update_status: null,
    enabled: true,
    enabled_for_match_making: true,
    servers: [],
    ...overrides,
  });

  const heartbeat = ({
    csBuild,
    csgoBuild,
    nodeIP = NODE_IP,
    rootDisk = disk(100, 50),
  }: {
    csBuild?: number;
    csgoBuild?: number;
    nodeIP?: string;
    rootDisk?: NodeDisk;
  }) =>
    service.updateStatus(
      NODE_ID,
      nodeIP,
      LAN_IP,
      PUBLIC_IP,
      csBuild,
      csgoBuild,
      true,
      true,
      cpuInfo,
      cpuGovernorInfo,
      cpuFrequencyInfo,
      undefined,
      "Online" as any,
      rootDisk,
      [],
    );

  const written = (column: string) =>
    hasura.mutation.mock.calls
      .map(([mutation]) => mutation.update_game_server_nodes_by_pk?.__args._set)
      .filter(Boolean)
      .map((set) => (column in set ? set[column] : "untouched"));

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
    await heartbeat({});
    expect(written("build_id")).toEqual([null]);
  });

  it("clears the CS:GO build once that install is gone", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({ csgo_build_id: CSGO_BUILD }),
    });
    await heartbeat({});
    expect(written("csgo_build_id")).toEqual([null]);
  });

  it("leaves the build alone while an update has the install torn down", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({
        build_id: BUILD,
        update_status: "Downloading",
      }),
    });
    await heartbeat({ rootDisk: disk(40, 80) });
    expect(written("build_id")).toEqual(["untouched"]);
  });

  it("writes nothing for a node that has never had CS2", async () => {
    hasura.query.mockResolvedValue({ game_server_nodes_by_pk: stored({}) });
    await heartbeat({});
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("records a build the connector reports", async () => {
    hasura.query.mockResolvedValue({ game_server_nodes_by_pk: stored({}) });
    await heartbeat({ csBuild: BUILD });
    expect(written("build_id")).toEqual([BUILD]);
  });

  // Both used to be refreshed by accident, on every heartbeat, by the CS:GO
  // build comparing null to undefined. A node whose CPU info never changes (a
  // VM, ARM) froze its node IP and disk figures once that stopped.
  it("refreshes the node IP when nothing else changed", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({ build_id: BUILD }),
    });
    await heartbeat({ csBuild: BUILD, nodeIP: "100.64.0.99" });
    expect(written("node_ip")).toEqual(["100.64.0.99"]);
  });

  it("refreshes free disk space when nothing else changed", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({ build_id: BUILD }),
    });
    await heartbeat({ csBuild: BUILD, rootDisk: disk(97, 50) });
    expect(written("disk_available_gb")).toEqual([97]);
  });

  it("refreshes disk usage when nothing else changed", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: stored({ build_id: BUILD }),
    });
    await heartbeat({ csBuild: BUILD, rootDisk: disk(100, 52) });
    expect(written("disk_used_percent")).toEqual([52]);
  });
});
