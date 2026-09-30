import {
  BuildNodeCandidate,
  GameServerNodeService,
  GamedataValidationEntry,
  GamedataValidationResult,
  NodeWorkloads,
} from "./game-server-node.service";

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
