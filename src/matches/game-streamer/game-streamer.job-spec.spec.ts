jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import { GameStreamerService, GpuNodeProfile } from "./game-streamer.service";

// Golden Job specs for the six game-streamer modes. The .snap file was
// written on unchanged main code, so any change to the Job that an NVIDIA
// node gets shows up here as a snapshot diff.

type Mode =
  | "live"
  | "create-clips"
  | "demo"
  | "batch-highlights"
  | "nade-previews"
  | "warm-shaders";

type GoldenInputs = {
  jobName: string;
  matchId: string;
  nodeId: string;
  extraEnv: Array<{ name: string; value: string }>;
  extraLabels: Record<string, string>;
};

const STEAM_ACCOUNT = {
  id: "sa-golden",
  username: "golden-bot",
  password: "golden-pw",
};

const INPUTS: Record<Mode, GoldenInputs> = {
  live: {
    jobName: "gs-live-match-golden",
    matchId: "match-golden",
    nodeId: "node-golden",
    extraEnv: [{ name: "CONNECT_ADDR", value: "10.0.0.5:27015" }],
    extraLabels: {},
  },
  "create-clips": {
    jobName: "gs-clips-match-golden",
    matchId: "match-golden",
    nodeId: "node-golden",
    extraEnv: [{ name: "CLIP_JOB_ID", value: "clip-golden" }],
    extraLabels: {},
  },
  demo: {
    jobName: "gs-demo-sessiongolde",
    matchId: "match-golden",
    nodeId: "node-golden",
    extraEnv: [{ name: "DEMO_SESSION_ID", value: "session-golden" }],
    extraLabels: { "session-id": "session-golden" },
  },
  "batch-highlights": {
    jobName: "gs-batch-mapgolde-demogold",
    matchId: "match-golden",
    nodeId: "node-golden",
    extraEnv: [{ name: "BATCH_MATCH_MAP_ID", value: "map-golden" }],
    extraLabels: {
      "match-map-id": "map-golden",
      "match-map-demo-id": "demo-golden",
    },
  },
  "nade-previews": {
    jobName: "gs-nades-demirage",
    matchId: "match-golden",
    nodeId: "node-golden",
    extraEnv: [{ name: "NADE_BATCH_MODE", value: "1" }],
    extraLabels: { "utility-map": "de_mirage" },
  },
  // The same inputs bakeShaders passes for node-golden when the node has no
  // cs2_video_settings, so the bake test can compare against this golden.
  "warm-shaders": {
    jobName: "shader-bake-node-golden",
    matchId: "node-golden",
    nodeId: "node-golden",
    extraEnv: [
      { name: "BAKE_NODE_ID", value: "node-golden" },
      { name: "CS2_VIDEO_SETTINGS", value: "{}" },
    ],
    extraLabels: { "node-id": "node-golden" },
  },
};

const MODES = Object.keys(INPUTS) as Mode[];

describe("GameStreamerService Job spec goldens", () => {
  let service: GameStreamerService;

  const config = {
    get: (key: string) => {
      if (key === "gameServers") {
        return {
          namespace: "test",
          gameStreamerImage: "5stack/game-streamer:golden",
        };
      }
      if (key === "app") {
        return { encSecret: "job-spec-fixture" };
      }
      if (key === "steam") {
        return { steamUser: "config-bot", steamPassword: "config-pw" };
      }
      return {} as any;
    },
  };

  const build = (mode: Mode) => {
    const input = INPUTS[mode];
    return service["buildJobSpec"](
      input.jobName,
      input.matchId,
      mode,
      input.nodeId,
      input.extraEnv,
      input.extraLabels,
      STEAM_ACCOUNT,
    );
  };

  beforeEach(() => {
    delete process.env.API_INTERNAL_BASE;
    delete process.env.GAME_STREAM_DOMAIN;
    delete process.env.DEBUG_STREAM;
    delete process.env.GAME_STREAMER_DISPLAY_TIER;

    service = new GameStreamerService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      config as any,
      { query: jest.fn(), mutation: jest.fn() } as any,
      { query: jest.fn(), transaction: jest.fn() } as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      {} as any,
      { claim: jest.fn(), release: jest.fn() } as any,
      { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
    );
  });

  it.each(MODES)("%s", (mode) => {
    expect(build(mode)).toMatchSnapshot();
  });

  const AMD_PROFILE: GpuNodeProfile = {
    vendor: "amd",
    pciAddress: "0000:c4:00.0",
  };

  const buildWithGpu = (
    mode: Mode,
    gpu: GpuNodeProfile | null,
    extraEnv = INPUTS[mode].extraEnv,
  ) => {
    const input = INPUTS[mode];
    return service["buildJobSpec"](
      input.jobName,
      input.matchId,
      mode,
      input.nodeId,
      extraEnv,
      input.extraLabels,
      STEAM_ACCOUNT,
      gpu,
    );
  };

  // build(mode) is the call that the "%s" cases above pin to the commit A
  // snapshot in this same run, so equal to it means equal to the golden.
  describe("NVIDIA identity", () => {
    it.each(MODES)("%s with a null profile equals the golden", (mode) => {
      expect(buildWithGpu(mode, null)).toStrictEqual(build(mode));
    });

    it.each(MODES)("%s with an nvidia profile equals the golden", (mode) => {
      expect(buildWithGpu(mode, { vendor: "nvidia" })).toStrictEqual(
        build(mode),
      );
    });
  });

  describe("AMD profile", () => {
    // Everything the AMD profile keeps from the NVIDIA Job.
    const kept = (job: ReturnType<typeof build>) => {
      const pod = job.spec.template.spec;
      const container = pod.containers[0];
      return {
        backoffLimit: job.spec.backoffLimit,
        ttlSecondsAfterFinished: job.spec.ttlSecondsAfterFinished,
        restartPolicy: pod.restartPolicy,
        dnsConfig: pod.dnsConfig,
        hostNetwork: pod.hostNetwork,
        dnsPolicy: pod.dnsPolicy,
        affinity: pod.affinity,
        initContainers: pod.initContainers,
        volumes: pod.volumes,
        containerName: container.name,
        image: container.image,
        imagePullPolicy: container.imagePullPolicy,
        securityContext: container.securityContext,
        args: container.args,
        ports: container.ports,
        volumeMounts: container.volumeMounts,
      };
    };

    it.each(MODES)("amd %s", (mode) => {
      expect(buildWithGpu(mode, AMD_PROFILE)).toMatchSnapshot();
    });

    it.each(MODES)(
      "amd %s changes only the runtime, the GPU resource, the label and the env",
      (mode) => {
        const nvidia = build(mode);
        const amd = buildWithGpu(mode, AMD_PROFILE);
        const pod = amd.spec.template.spec;
        const env = pod.containers[0].env;

        expect(pod).not.toHaveProperty("runtimeClassName");
        expect(pod.containers[0].resources).toStrictEqual({
          limits: { memory: "16Gi" },
          requests: { memory: "8Gi" },
        });
        expect(amd.metadata.labels).toStrictEqual({
          ...nvidia.metadata.labels,
          "5stack-gpu-vendor": "amd",
        });
        expect(amd.spec.template.metadata.labels).toStrictEqual(
          amd.metadata.labels,
        );
        expect(amd.spec.template.metadata.labels).not.toBe(amd.metadata.labels);
        expect(env.slice(0, -2)).toStrictEqual(
          nvidia.spec.template.spec.containers[0].env,
        );
        expect(env.slice(-2)).toStrictEqual([
          { name: "GS_GPU_VENDOR", value: "amd" },
          { name: "GS_GPU_PCI_ADDRESS", value: "0000:c4:00.0" },
        ]);
        const names = env.map((entry) => entry.name);
        expect(names).not.toContain("GS_RENDER_NODE");
        expect(names).not.toContain("GS_DISPLAY_TIER");
        expect(kept(amd)).toStrictEqual(kept(nvidia));
      },
    );

    it("puts the GPU env after extraEnv, so it wins over duplicates", () => {
      const env = buildWithGpu("live", AMD_PROFILE, [
        ...INPUTS.live.extraEnv,
        { name: "GS_GPU_VENDOR", value: "nvidia" },
        { name: "GS_GPU_PCI_ADDRESS", value: "0000:01:00.0" },
      ]).spec.template.spec.containers[0].env;

      expect(env.slice(-4)).toStrictEqual([
        { name: "GS_GPU_VENDOR", value: "nvidia" },
        { name: "GS_GPU_PCI_ADDRESS", value: "0000:01:00.0" },
        { name: "GS_GPU_VENDOR", value: "amd" },
        { name: "GS_GPU_PCI_ADDRESS", value: "0000:c4:00.0" },
      ]);
    });
  });

  // GAME_STREAMER_DISPLAY_TIER is read on every build, and only the AMD
  // profile passes it on, as GS_DISPLAY_TIER.
  describe("display tier", () => {
    const liveEnv = () =>
      buildWithGpu("live", AMD_PROFILE).spec.template.spec.containers[0].env;

    it.each(MODES)("amd %s with tier C", (mode) => {
      process.env.GAME_STREAMER_DISPLAY_TIER = "C";
      expect(buildWithGpu(mode, AMD_PROFILE)).toMatchSnapshot();
    });

    it("adds nothing while GAME_STREAMER_DISPLAY_TIER is unset", () => {
      expect(liveEnv().at(-1)).toStrictEqual({
        name: "GS_GPU_PCI_ADDRESS",
        value: "0000:c4:00.0",
      });
      expect(service["logger"].warn).not.toHaveBeenCalled();
    });

    it.each([
      ["A", "A"],
      ["C", "C"],
      [" C ", "C"],
    ])("%p adds GS_DISPLAY_TIER=%s as the last env entry", (value, tier) => {
      const unset = liveEnv();
      process.env.GAME_STREAMER_DISPLAY_TIER = value;

      expect(liveEnv()).toStrictEqual([
        ...unset,
        { name: "GS_DISPLAY_TIER", value: tier },
      ]);
      expect(service["logger"].warn).not.toHaveBeenCalled();
    });

    it.each(["B", "c", "x"])("%p is dropped with one warning", (value) => {
      const unset = liveEnv();
      process.env.GAME_STREAMER_DISPLAY_TIER = value;

      expect(liveEnv()).toStrictEqual(unset);
      expect(service["logger"].warn).toHaveBeenCalledTimes(1);
      expect(service["logger"].warn).toHaveBeenCalledWith(
        expect.stringContaining(`GAME_STREAMER_DISPLAY_TIER "${value}"`),
      );
    });

    it.each(["", "  "])("%p adds nothing and does not warn", (value) => {
      const unset = liveEnv();
      process.env.GAME_STREAMER_DISPLAY_TIER = value;

      expect(liveEnv()).toStrictEqual(unset);
      expect(service["logger"].warn).not.toHaveBeenCalled();
    });

    it("puts GS_DISPLAY_TIER last, so it wins over extraEnv", () => {
      process.env.GAME_STREAMER_DISPLAY_TIER = "C";
      const env = buildWithGpu("live", AMD_PROFILE, [
        ...INPUTS.live.extraEnv,
        { name: "GS_DISPLAY_TIER", value: "A" },
      ]).spec.template.spec.containers[0].env;

      expect(env.slice(-4)).toStrictEqual([
        { name: "GS_DISPLAY_TIER", value: "A" },
        { name: "GS_GPU_VENDOR", value: "amd" },
        { name: "GS_GPU_PCI_ADDRESS", value: "0000:c4:00.0" },
        { name: "GS_DISPLAY_TIER", value: "C" },
      ]);
    });

    // golden is built before the env is set: the call that the "%s" cases
    // pin to the commit A snapshot.
    it.each(MODES)("%s with a null profile ignores tier C", (mode) => {
      const golden = build(mode);
      process.env.GAME_STREAMER_DISPLAY_TIER = "C";

      expect(buildWithGpu(mode, null)).toStrictEqual(golden);
    });

    it.each(MODES)("%s with an nvidia profile ignores tier C", (mode) => {
      const golden = build(mode);
      process.env.GAME_STREAMER_DISPLAY_TIER = "C";

      expect(buildWithGpu(mode, { vendor: "nvidia" })).toStrictEqual(golden);
    });

    it("never warns about the tier for a null or nvidia profile", () => {
      process.env.GAME_STREAMER_DISPLAY_TIER = "x";

      buildWithGpu("live", null);
      buildWithGpu("live", { vendor: "nvidia" });

      expect(service["logger"].warn).not.toHaveBeenCalled();
    });
  });
});
