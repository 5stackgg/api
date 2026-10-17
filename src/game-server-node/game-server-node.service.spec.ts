import {
  BuildNodeCandidate,
  GameServerNodeService,
  GamedataValidationEntry,
  GamedataValidationResult,
  NodeWorkloads,
} from "./game-server-node.service";
import { GpuDevice } from "./interfaces/NodeStats";

const entry = (
  signature: string,
  fields: Partial<GamedataValidationEntry> = {},
): GamedataValidationEntry => ({
  set: "fivestack",
  signature,
  kind: "signature",
  count: 1,
  ok: true,
  ...fields,
});

const run = (
  results: Array<GamedataValidationEntry>,
  fields: Partial<GamedataValidationResult> = {},
): GamedataValidationResult => ({
  status: results.some((result) => result.ok === false) ? "fail" : "pass",
  results,
  broken: results.filter((result) => result.ok === false),
  warnings: results.filter((result) => result.ok && (result.count ?? 0) > 1),
  skipped: results.filter((result) => result.skipped),
  ...fields,
});

describe("GameServerNodeService.diffGamedata", () => {
  it("counts the run but compares nothing without a previous build", () => {
    const current = run([
      entry("A"),
      entry("B", { ok: false, count: 0 }),
      entry("C", { skipped: true, ok: null, count: null }),
    ]);

    expect(GameServerNodeService.diffGamedata(current, null)).toEqual({
      comparable: false,
      counts: { checked: 2, broken: 1, warnings: 0, skipped: 1 },
      newly_broken: [],
      fixed: [],
      new_warnings: [],
      cleared_warnings: [],
    });
  });

  it("finds what broke and what was fixed", () => {
    const previous = run([
      entry("StillBroken", { ok: false, count: 0 }),
      entry("Fixed", { ok: false, count: 0 }),
      entry("Breaks"),
    ]);
    const current = run([
      entry("StillBroken", { ok: false, count: 0 }),
      entry("Fixed"),
      entry("Breaks", { ok: false, count: 0 }),
    ]);

    const changes = GameServerNodeService.diffGamedata(current, previous);

    expect(changes.newly_broken.map(({ signature }) => signature)).toEqual([
      "Breaks",
    ]);
    expect(changes.newly_broken[0]).toMatchObject({
      previous_count: 1,
      count: 0,
    });
    expect(changes.fixed.map(({ signature }) => signature)).toEqual(["Fixed"]);
    expect(changes.fixed[0]).toMatchObject({ previous_count: 0, count: 1 });
  });

  it("does not call an entry fixed when the new run skipped it", () => {
    const previous = run([entry("Flaky", { ok: false, count: 0 })]);
    const current = run([
      entry("Flaky", { skipped: true, ok: null, count: null }),
    ]);

    expect(GameServerNodeService.diffGamedata(current, previous).fixed).toEqual(
      [],
    );
  });

  it("does not call an entry fixed when the new run no longer checks it", () => {
    const previous = run([entry("Dropped", { ok: false, count: 0 })]);
    const current = run([entry("Other")]);

    expect(GameServerNodeService.diffGamedata(current, previous).fixed).toEqual(
      [],
    );
  });

  it("keeps the same name in different sets or kinds apart", () => {
    const previous = run([entry("Same", { ok: false, count: 0 })]);
    const current = run([
      entry("Same"),
      entry("Same", { kind: "vtable", ok: false, count: 0 }),
      entry("Same", { set: "upstream-ccs", ok: false, count: 0 }),
    ]);

    const changes = GameServerNodeService.diffGamedata(current, previous);

    expect(changes.fixed).toHaveLength(1);
    expect(
      changes.newly_broken.map(({ set, kind }) => `${set}/${kind}`),
    ).toEqual(["fivestack/vtable", "upstream-ccs/signature"]);
  });

  it("does not call a warning cleared when the new run skipped it", () => {
    const previous = run([entry("Ambiguous", { count: 2 })]);
    const current = run([
      entry("Ambiguous", { skipped: true, ok: null, count: null }),
    ]);

    expect(
      GameServerNodeService.diffGamedata(current, previous).cleared_warnings,
    ).toEqual([]);
  });

  it("tracks warnings that appeared and cleared", () => {
    const previous = run([entry("WasAmbiguous", { count: 3 }), entry("Fine")]);
    const current = run([entry("WasAmbiguous"), entry("Fine", { count: 2 })]);

    const changes = GameServerNodeService.diffGamedata(current, previous);

    expect(changes.new_warnings.map(({ signature }) => signature)).toEqual([
      "Fine",
    ]);
    expect(changes.new_warnings[0]).toMatchObject({
      previous_count: 1,
      count: 2,
    });
    expect(changes.cleared_warnings.map(({ signature }) => signature)).toEqual([
      "WasAmbiguous",
    ]);
  });
});

describe("GameServerNodeService build nodes", () => {
  const node = (
    fields: Partial<BuildNodeCandidate> = {},
  ): BuildNodeCandidate => ({
    id: "node-a",
    label: null,
    status: "Online",
    enabled: true,
    build_id: 25537370,
    update_status: null,
    gpu: false,
    enabled_for_match_making: true,
    ...fields,
  });

  it("accepts an online node on the build", () => {
    expect(
      GameServerNodeService.buildNodeIneligibility(node(), 25537370),
    ).toBeNull();
  });

  it.each([
    [{ enabled: false }, "node-a is disabled"],
    [
      { gpu: true, enabled_for_match_making: false },
      "node-a is a GPU-only node",
    ],
    [{ status: "Offline" }, "node-a is Offline"],
    [{ update_status: "Updating" }, "node-a is updating CS2"],
    [{ build_id: 25400000 }, "node-a is on build 25400000, not 25537370"],
    [
      { build_id: 25400000, label: "EU West" },
      "EU West is on build 25400000, not 25537370",
    ],
  ])("refuses %o", (fields, reason) => {
    expect(
      GameServerNodeService.buildNodeIneligibility(node(fields), 25537370),
    ).toBe(reason);
  });

  it("still accepts a GPU node that also hosts matches", () => {
    expect(
      GameServerNodeService.buildNodeIneligibility(
        node({ gpu: true, enabled_for_match_making: true }),
        25537370,
      ),
    ).toBeNull();
  });

  it("prefers a node that is not busy with the other job", () => {
    expect(
      GameServerNodeService.pickBuildNode(
        [{ id: "node-a" }, { id: "node-b" }],
        new Set(["node-a"]),
      ),
    ).toBe("node-b");
  });

  it("picks the same node every time when nothing is busy", () => {
    expect(
      GameServerNodeService.pickBuildNode(
        [{ id: "node-c" }, { id: "node-a" }, { id: "node-b" }],
        new Set(),
      ),
    ).toBe("node-a");
  });

  it("falls back to a busy node rather than none", () => {
    expect(
      GameServerNodeService.pickBuildNode(
        [{ id: "node-a" }],
        new Set(["node-a"]),
      ),
    ).toBe("node-a");
    expect(GameServerNodeService.pickBuildNode([], new Set())).toBeNull();
  });
});

describe("GameServerNodeService gamedata errors", () => {
  it("only treats a run that scanned something as a result", () => {
    expect(
      GameServerNodeService.validatedAnything({
        status: "error",
        broken: [],
        error: "no pod",
      }),
    ).toBe(false);
    expect(
      GameServerNodeService.validatedAnything(
        run([entry("A")], { status: "error" }),
      ),
    ).toBe(true);
  });

  it("explains an error the validator reported without a message", () => {
    expect(
      GameServerNodeService.gamedataErrorReason({
        status: "error",
        broken: [],
        swiftly: { error: "could not fetch SwiftlyS2 gamedata for 1.4.2" },
      }),
    ).toBe("could not fetch SwiftlyS2 gamedata for 1.4.2");
    expect(
      GameServerNodeService.gamedataErrorReason({
        status: "error",
        broken: [],
        statuses: { fivestack: "pass", "upstream-swiftly": "error" },
      }),
    ).toBe("could not verify upstream-swiftly");
    expect(
      GameServerNodeService.gamedataErrorReason({
        status: "error",
        broken: [],
        error: "no pod was scheduled",
      }),
    ).toBe("no pod was scheduled");
  });
});

describe("GameServerNodeService.isInService", () => {
  const node = (fields: Partial<NodeWorkloads> = {}): NodeWorkloads => ({
    enabled: true,
    enabled_for_match_making: true,
    gpu_streaming_enabled: true,
    gpu_demos_enabled: true,
    gpu_rendering_enabled: true,
    servers: [],
    ...fields,
  });

  const gpuMode = (fields: Partial<NodeWorkloads> = {}) =>
    node({ enabled_for_match_making: false, ...fields });

  it("counts an enabled match node", () => {
    expect(GameServerNodeService.isInService(node())).toBe(true);
  });

  it("drops a disabled node", () => {
    expect(GameServerNodeService.isInService(node({ enabled: false }))).toBe(
      false,
    );
  });

  it("keeps a disabled node that still hosts an enabled dedicated server", () => {
    expect(
      GameServerNodeService.isInService(
        node({ enabled: false, servers: [{ id: "server-1" }] }),
      ),
    ).toBe(true);
  });

  it("counts a GPU-mode node while any GPU workload is on", () => {
    expect(
      GameServerNodeService.isInService(
        gpuMode({ gpu_streaming_enabled: false, gpu_demos_enabled: false }),
      ),
    ).toBe(true);
  });

  it("drops a GPU-mode node with every workload off", () => {
    expect(
      GameServerNodeService.isInService(
        gpuMode({
          gpu_streaming_enabled: false,
          gpu_demos_enabled: false,
          gpu_rendering_enabled: false,
        }),
      ),
    ).toBe(false);
  });

  it("keeps a GPU-mode node with workloads off that hosts a dedicated server", () => {
    expect(
      GameServerNodeService.isInService(
        gpuMode({
          gpu_streaming_enabled: false,
          gpu_demos_enabled: false,
          gpu_rendering_enabled: false,
          servers: [{ id: "server-1" }],
        }),
      ),
    ).toBe(true);
  });
});

describe("GameServerNodeService.updateStatus GPU vendor", () => {
  // The stored row matches every ping below except in its GPU columns. Its
  // build ids are numbers equal to the pinged ones and no update is running,
  // so neither the build change branch nor createVolumes runs.
  const storedNode = (
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    token: null,
    status: "Online",
    label: "gpu-node",
    offline_at: null,
    enabled: true,
    enabled_for_match_making: false,
    gpu_streaming_enabled: true,
    gpu_demos_enabled: true,
    gpu_rendering_enabled: true,
    servers: [],
    lan_ip: "10.0.0.2",
    node_ip: "10.0.0.2",
    build_id: 20512345,
    csgo_build_id: 7654321,
    public_ip: "203.0.113.2",
    gpu: false,
    gpu_info: null,
    gpu_vendor: null,
    cpu_sockets: 1,
    cpu_cores_per_socket: 8,
    cpu_threads_per_core: 2,
    supports_low_latency: false,
    supports_cpu_pinning: false,
    cpu_governor_info: { governor: "performance", cpus: { 0: "performance" } },
    cpu_frequency_info: { cpus: { 0: 3000 }, frequency: 3000 },
    cpu_warnings: [],
    update_status: null,
    ...fields,
  });

  // An in-memory Hasura: a query returns only the selected columns of the
  // row, and an update merges its _set into the row as the table stores it.
  const build = (row: Record<string, unknown>) => {
    const hasura = {
      query: jest.fn(async (query: Record<string, any>) => ({
        game_server_nodes_by_pk: Object.fromEntries(
          Object.keys(query.game_server_nodes_by_pk)
            .filter((column) => column !== "__args")
            .map((column) => [column, structuredClone(row[column])]),
        ),
      })),
      mutation: jest.fn(async (mutation: Record<string, any>) => {
        Object.assign(
          row,
          JSON.parse(
            JSON.stringify(mutation.update_game_server_nodes_by_pk.__args._set),
          ),
        );
        return {};
      }),
    };
    const nodes = new GameServerNodeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: () => ({ namespace: "5stack" }) } as any,
      hasura as any,
      { getConnection: () => ({}) } as any,
      {} as any,
      {} as any,
      {} as any,
      {
        queueBuild: jest.fn().mockResolvedValue(true),
        queueCalloutsSync: jest.fn().mockResolvedValue(undefined),
      } as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
    );
    const writes = () =>
      hasura.mutation.mock.calls.map(
        ([mutation]) => mutation.update_game_server_nodes_by_pk.__args._set,
      );
    return { nodes, writes };
  };

  // Today's 15 arguments, plus gpuVendor only when a case passes one.
  const ping = (
    nodes: GameServerNodeService,
    gpu: { count: number; devices: Array<GpuDevice> | null },
    ...gpuVendor: [] | ["nvidia" | "amd"]
  ) =>
    nodes.updateStatus(
      "gpu-node",
      "10.0.0.2",
      "10.0.0.2",
      "203.0.113.2",
      20512345,
      7654321,
      false,
      false,
      { sockets: 1, coresPerSocket: 8, threadsPerCore: 2 },
      { governor: "performance", cpus: { 0: "performance" } },
      { cpus: { 0: 3000 }, frequency: 3000 },
      gpu,
      "Online",
      undefined,
      [],
      ...gpuVendor,
    );

  const nvidiaDevice: GpuDevice = {
    index: 0,
    name: "NVIDIA GeForce RTX 3060",
    memory_mb: 12288,
    memory_used_mb: 1024,
    temperature_c: 41,
    power_w: 35,
    utilization_percent: 2,
  };

  // The device as mergeAmdGpu hands it on: index 0, a lowercase PCI address.
  const amdDevice: GpuDevice = {
    index: 0,
    name: "AMD Radeon 8060S Graphics",
    memory_mb: 512,
    memory_used_mb: 180,
    gtt_total_mb: 65536,
    gtt_used_mb: 2300,
    utilization_percent: 3,
    temperature_c: 46,
    power_w: 28,
    encoder_utilization_percent: 0,
    pci_bus_id: "0000:c5:00.0",
    pci_id: "1002:1586",
    pci_revision: "c1",
    render_node: "renderD128",
    integrated: true,
  };

  it("stores an NVIDIA ping as 'nvidia' with today's gpu_info, and writes once", async () => {
    const { nodes, writes } = build(storedNode());

    await ping(nodes, { count: 1, devices: [nvidiaDevice] });
    await ping(nodes, { count: 1, devices: [nvidiaDevice] });

    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ gpu: true, gpu_vendor: "nvidia" });
    expect(writes()[0].gpu_info).toStrictEqual([
      { index: 0, name: "NVIDIA GeForce RTX 3060", memory_mb: 12288 },
    ]);
  });

  it("stores an AMD ping as 'amd' with the five identity keys, and writes once", async () => {
    const { nodes, writes } = build(storedNode());

    await ping(nodes, { count: 1, devices: [amdDevice] }, "amd");
    await ping(nodes, { count: 1, devices: [amdDevice] }, "amd");

    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ gpu: true, gpu_vendor: "amd" });
    expect(writes()[0].gpu_info).toStrictEqual([
      {
        index: 0,
        name: "AMD Radeon 8060S Graphics",
        memory_mb: 512,
        pci_bus_id: "0000:c5:00.0",
        pci_id: "1002:1586",
        pci_revision: "c1",
        render_node: "renderD128",
        integrated: true,
      },
    ]);
  });

  it.each([
    ["the default vendor", []],
    ["'amd'", ["amd"]],
  ] as Array<[string, [] | ["amd"]]>)(
    "stores a CPU node as gpu false with no vendor when called with %s, and writes once",
    async (_label, gpuVendor) => {
      // The row still holds the GPU the node had before, so the first ping
      // writes.
      const { nodes, writes } = build(
        storedNode({
          gpu: true,
          gpu_vendor: "nvidia",
          gpu_info: [
            { index: 0, name: "NVIDIA GeForce RTX 3060", memory_mb: 12288 },
          ],
        }),
      );

      await ping(nodes, { count: 0, devices: null }, ...gpuVendor);
      await ping(nodes, { count: 0, devices: null }, ...gpuVendor);

      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({
        gpu: false,
        gpu_vendor: null,
        gpu_info: null,
      });
    },
  );

  it("stores a legacy nvidiaGPU ping as 'nvidia', and writes once", async () => {
    // The gpu the controller builds from an old connector's
    // { nvidiaGPU: true, gpuInfo: null }.
    const { nodes, writes } = build(storedNode());

    await ping(nodes, { count: 1, devices: null });
    await ping(nodes, { count: 1, devices: null });

    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      gpu: true,
      gpu_vendor: "nvidia",
      gpu_info: null,
    });
  });
});
