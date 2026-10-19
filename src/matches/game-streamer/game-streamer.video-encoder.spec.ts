const createNamespacedJob = jest.fn();
const readNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const listNamespacedPod = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    createNamespacedJob = createNamespacedJob;
    readNamespacedJob = readNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = listNamespacedPod;
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import { GameStreamerService } from "./game-streamer.service";
import type { V1EnvVar, V1Job } from "@kubernetes/client-node";

type Setting = string | undefined | Error;
const NODE_ID = "node-golden";
const MATCH_ID = "match-golden";
const MATCH_MAP_ID = "map-golden";
const DEMO_ID = "demo-golden";
const SESSION_ID = "session-golden";
const STEAM_ACCOUNT = {
  id: "sa-golden",
  username: "golden-bot",
  password: "golden-pw",
};

// Standalone fixtures keep the setting PR independent of the AMD PR.
function makeService(value: Setting = undefined) {
  createNamespacedJob.mockReset().mockResolvedValue({});
  readNamespacedJob.mockReset().mockRejectedValue({ code: 404 });
  deleteNamespacedJob.mockReset().mockResolvedValue({});
  listNamespacedPod.mockReset().mockResolvedValue({ items: [] });

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const hasura = {
    query: jest.fn(async (query: Record<string, any>) => {
      if (query.settings_by_pk) {
        if (query.settings_by_pk.__args.name !== "video_encoder") {
          return { settings_by_pk: null };
        }
        if (value instanceof Error) throw value;
        return {
          settings_by_pk: value === undefined ? null : { value },
        };
      }
      if (query.match_map_demos) {
        return {
          match_map_demos: [
            {
              id: DEMO_ID,
              match_id: MATCH_ID,
              match_map_id: MATCH_MAP_ID,
              file: "golden.dem",
              total_ticks: null,
              tick_rate: null,
              round_ticks: null,
              workshop_id: null,
              cs2_build: null,
            },
          ],
        };
      }
      if (query.matches_by_pk) {
        return {
          matches_by_pk: {
            id: MATCH_ID,
            status: "Live",
            password: "match-pw",
            server: {
              host: "10.0.0.5",
              port: 27015,
              tv_port: null,
              connected: true,
              enabled: true,
              server_region: { is_lan: false },
              game_server_node: { node_ip: null },
            },
          },
        };
      }
      if (query.game_server_nodes_by_pk) {
        return {
          game_server_nodes_by_pk: {
            id: NODE_ID,
            gpu: true,
            shader_bake_status: null,
            cs2_video_settings: null,
          },
        };
      }
      return {};
    }),
    mutation: jest.fn(async (mutation: Record<string, unknown>) =>
      "insert_match_demo_sessions_one" in mutation
        ? { insert_match_demo_sessions_one: { id: SESSION_ID } }
        : {},
    ),
  };
  const postgres = {
    query: jest.fn().mockResolvedValue([]),
    transaction: jest.fn(async (fn: (client: unknown) => unknown) =>
      fn({
        query: jest
          .fn()
          .mockResolvedValue({ rows: [{ game_server_node_id: NODE_ID }] }),
      }),
    ),
  };
  const service = new GameStreamerService(
    logger as any,
    {
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
        return {};
      },
    } as any,
    hasura as any,
    postgres as any,
    { getConnection: jest.fn() } as any,
    {
      resolvePlayableDemoUrl: jest
        .fn()
        .mockResolvedValue("https://demos.test/golden.dem"),
    } as any,
    {} as any,
    {
      claim: jest.fn().mockResolvedValue(STEAM_ACCOUNT),
      release: jest.fn(),
    } as any,
    { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
  );
  for (const name of [
    "stopDemoSessionById",
    "unregisterStreamRow",
    "releaseNadeRenderClaim",
    "createDemoService",
    "createLiveService",
    "monitorBakeShaders",
  ]) {
    jest.spyOn(service as any, name).mockResolvedValue(undefined);
  }
  return {
    service,
    logger,
    hasura,
    buildJobSpec: jest.spyOn(service as any, "buildJobSpec"),
  };
}

const ENV_KEYS = [
  "API_INTERNAL_BASE",
  "GAME_STREAM_DOMAIN",
  "DEBUG_STREAM",
  "GS_VIDEO_ENCODER",
  "VIDEO_ENCODER",
];
let savedEnv: Array<string | undefined>;

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key) => process.env[key]);
  ENV_KEYS.forEach((key) => delete process.env[key]);
  jest.useFakeTimers();
});

afterEach(() => {
  ENV_KEYS.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("video encoder setting resolver (S7-U1)", () => {
  it.each([
    [undefined, "auto"],
    ["auto", "auto"],
    ["gpu", "gpu"],
    ["cpu", "cpu"],
    [" GPU ", "gpu"],
    ["", "auto"],
    ["junk", "auto"],
  ] as const)("reads %s as %s", async (value, expected) => {
    const { service, hasura, logger } = makeService(value);
    expect(await service["resolveVideoEncoder"]()).toBe(expected);
    expect(hasura.query).toHaveBeenCalledTimes(1);
    if (value === "junk") {
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'ignoring video_encoder setting "junk": expected auto, gpu or cpu',
      );
    } else {
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it("uses auto after a read failure with only readSetting's warning", async () => {
    const { service, logger } = makeService(new Error("setting unavailable"));
    expect(await service["resolveVideoEncoder"]()).toBe("auto");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "failed to read video_encoder setting: setting unavailable",
    );
  });

  it("has no environment fallback", async () => {
    process.env.GS_VIDEO_ENCODER = "cpu";
    process.env.VIDEO_ENCODER = "cpu";
    const { service } = makeService();
    expect(await service["resolveVideoEncoder"]()).toBe("auto");
  });

  it.each([
    [undefined, []],
    ["auto", []],
    ["gpu", [{ name: "GS_VIDEO_ENCODER", value: "gpu" }]],
    ["cpu", [{ name: "GS_VIDEO_ENCODER", value: "cpu" }]],
  ] as const)("builds env for %s", async (value, expected) => {
    const { service } = makeService(value);
    expect(await service["videoEncoderEnv"]()).toEqual(expected);
  });
});

type PathName = "demo" | "live" | "batch" | "nades" | "bake";
const JOBS = [{ job_id: "clip-1", session_token: "token-1", spec: {} }];

async function dispatch(path: PathName, value: Setting) {
  const context = makeService(value);
  const { service } = context;
  switch (path) {
    case "demo":
      await service.startDemoPlayback(MATCH_MAP_ID, "76561198000000001", {
        demoId: DEMO_ID,
        demoFile: "golden.dem",
        presignedDemoUrl: "https://demos.test/golden.dem",
        roundTicks: null,
        totalTicks: null,
        tickRate: null,
        workshopId: null,
        cs2Build: null,
      });
      break;
    case "live":
      await service.startLive(MATCH_ID, "live");
      break;
    case "batch":
      await service.dispatchBatchHighlights(MATCH_MAP_ID, JOBS, DEMO_ID);
      break;
    case "nades":
      await service.dispatchNadePreviews(
        "de_mirage",
        MATCH_ID,
        { addr: "127.0.0.1:27015", password: "server-pw", nodeId: NODE_ID },
        JOBS,
      );
      break;
    case "bake":
      await service.bakeShaders(NODE_ID);
      break;
  }
  expect(createNamespacedJob).toHaveBeenCalledTimes(1);
  return {
    ...context,
    env: context.buildJobSpec.mock.calls[0][4] as V1EnvVar[],
    body: createNamespacedJob.mock.calls[0][0].body as V1Job,
  };
}

describe.each<PathName>(["demo", "live", "batch", "nades", "bake"])(
  "video encoder dispatch for %s (S7-U2)",
  (path) => {
    it.each([
      undefined,
      "auto",
      "gpu",
      "cpu",
      new Error("setting unavailable"),
    ])("carries the setting %s without changing auto specs", async (value) => {
      const baseline = await dispatch(path, undefined);
      const actual = await dispatch(path, value);
      const entry =
        path !== "bake" && (value === "gpu" || value === "cpu")
          ? [{ name: "GS_VIDEO_ENCODER", value }]
          : [];
      expect(actual.env).toEqual([...baseline.env, ...entry]);
      const podEnv = actual.body.spec.template.spec.containers[0].env;
      if (entry.length) {
        expect(podEnv[podEnv.length - 1]).toEqual(entry[0]);
        expect(podEnv.filter((e) => e.name === "GS_VIDEO_ENCODER")).toEqual(
          entry,
        );
      } else {
        expect(actual.body).toEqual(baseline.body);
        expect(podEnv.some((e) => e.name === "GS_VIDEO_ENCODER")).toBe(false);
      }
      if (path === "bake") {
        const reads = actual.hasura.query.mock.calls.filter(
          ([query]) => query.settings_by_pk?.__args.name === "video_encoder",
        );
        expect(reads).toHaveLength(0);
      }
    });
  },
);
