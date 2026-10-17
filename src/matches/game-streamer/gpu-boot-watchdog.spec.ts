const listNamespacedJob = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    listNamespacedJob = listNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import type {
  CoreV1Event,
  V1ContainerStatus,
  V1Job,
  V1Pod,
  V1PodCondition,
  V1PodStatus,
} from "@kubernetes/client-node";
import type { LoggingService } from "../../k8s/logging/logging.service";
import { GameStreamerService } from "./game-streamer.service";
import {
  AMD_BOOT_WATCHDOG_SECONDS,
  AMD_GPU_JOB_SELECTOR,
  FREE_PORTS_WAIT_SUBSTRING,
  GpuJobBootVerdict,
  classifyGpuJobBoot,
} from "./gpu-boot-watchdog";

// FailedScheduling messages in the kube-scheduler's wording.
const FREE_PORTS =
  "0/2 nodes are available: 1 node(s) didn't have free ports for the requested pod ports, 1 node(s) didn't match Pod's node affinity/selector. preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.";
const CORDON =
  "0/2 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 1 node(s) were unschedulable. preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.";
const TAINT =
  "0/2 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 1 node(s) had untolerated taint {node.kubernetes.io/not-ready: }. preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.";
const INSUFFICIENT =
  "0/2 nodes are available: 1 Insufficient memory, 1 node(s) didn't match Pod's node affinity/selector. preemption: 0/2 nodes are available: 1 No preemption victims found for incoming pod, 1 Preemption is not helpful for scheduling.";

describe("classifyGpuJobBoot", () => {
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const ago = (seconds: number) => new Date(NOW - seconds * 1000);

  const amdJob = (
    status: V1Job["status"] = {},
    ageSeconds = AMD_BOOT_WATCHDOG_SECONDS + 60,
  ): V1Job => ({
    metadata: { name: "gs-live-match-1", creationTimestamp: ago(ageSeconds) },
    status,
  });

  const amdPod = (status: V1PodStatus, deleting = false): V1Pod => ({
    metadata: {
      name: "gs-live-match-1-x7k2p",
      deletionTimestamp: deleting ? ago(5) : undefined,
    },
    status: { phase: "Pending", ...status },
  });

  const unscheduled = (message: string): V1PodCondition => ({
    type: "PodScheduled",
    status: "False",
    reason: "Unschedulable",
    message,
  });

  const SCHEDULED: V1PodCondition = { type: "PodScheduled", status: "True" };

  const waiting = (name: string, reason: string): V1ContainerStatus => ({
    name,
    image: "5stack/game-streamer:test",
    imageID: "",
    ready: false,
    restartCount: 0,
    state: { waiting: { reason } },
  });

  const event = (
    kind: "Job" | "Pod",
    reason: string,
    secondsAgo: number,
    message = "",
  ): CoreV1Event => ({
    metadata: { name: `gs-live-match-1.${reason}.${secondsAgo}` },
    involvedObject: { kind, name: "gs-live-match-1" },
    reason,
    message,
    lastTimestamp: ago(secondsAgo),
  });

  const creating = amdPod({
    conditions: [SCHEDULED],
    containerStatuses: [waiting("live", "ContainerCreating")],
  });

  it.each<{
    name: string;
    job: V1Job;
    pod: V1Pod | null;
    events: CoreV1Event[];
    verdict: GpuJobBootVerdict;
  }>([
    {
      name: "a finished Job",
      job: amdJob({ failed: 1 }),
      pod: null,
      events: [],
      verdict: "ignore",
    },
    {
      name: "a Job younger than 180 s",
      job: amdJob({ active: 1 }, AMD_BOOT_WATCHDOG_SECONDS - 1),
      pod: null,
      events: [],
      verdict: "wait",
    },
    {
      name: "no pod",
      job: amdJob({ active: 1 }),
      pod: null,
      events: [],
      verdict: "unstartable",
    },
    {
      name: "a deletionTimestamp",
      job: amdJob({ active: 1 }),
      pod: amdPod({ conditions: [unscheduled(CORDON)] }, true),
      events: [],
      verdict: "wait",
    },
    {
      name: "Running",
      job: amdJob({ active: 1 }),
      pod: amdPod({ phase: "Running", conditions: [SCHEDULED] }),
      events: [],
      verdict: "ignore",
    },
    {
      name: "PodScheduled False on free ports",
      job: amdJob({ active: 1 }),
      pod: amdPod({ conditions: [unscheduled(FREE_PORTS)] }),
      events: [event("Pod", "FailedScheduling", 10, FREE_PORTS)],
      verdict: "wait",
    },
    {
      name: "PodScheduled False for a cordon",
      job: amdJob({ active: 1 }),
      pod: amdPod({ conditions: [unscheduled(CORDON)] }),
      events: [event("Pod", "FailedScheduling", 10, CORDON)],
      verdict: "unstartable",
    },
    {
      name: "PodScheduled False for a taint",
      job: amdJob({ active: 1 }),
      pod: amdPod({ conditions: [unscheduled(TAINT)] }),
      events: [event("Pod", "FailedScheduling", 10, TAINT)],
      verdict: "unstartable",
    },
    {
      name: "PodScheduled False for Insufficient memory",
      job: amdJob({ active: 1 }),
      pod: amdPod({ conditions: [unscheduled(INSUFFICIENT)] }),
      events: [event("Pod", "FailedScheduling", 10, INSUFFICIENT)],
      verdict: "unstartable",
    },
    {
      name: "an ErrImagePull waiting reason",
      job: amdJob({ active: 1 }),
      pod: amdPod({
        conditions: [SCHEDULED],
        containerStatuses: [waiting("live", "ErrImagePull")],
      }),
      events: [event("Pod", "Pulling", 20)],
      verdict: "unstartable",
    },
    {
      name: "an ImagePullBackOff init container",
      job: amdJob({ active: 1 }),
      pod: amdPod({
        conditions: [SCHEDULED],
        initContainerStatuses: [waiting("prep-cache", "ImagePullBackOff")],
        containerStatuses: [waiting("live", "PodInitializing")],
      }),
      events: [],
      verdict: "unstartable",
    },
    {
      name: "FailedCreatePodSandBox as the newest event",
      job: amdJob({ active: 1 }),
      pod: creating,
      events: [
        event("Pod", "Scheduled", 170),
        event("Pod", "FailedCreatePodSandBox", 5),
      ],
      verdict: "unstartable",
    },
    {
      name: "FailedCreatePodSandBox with a newer Job event",
      job: amdJob({ active: 1 }),
      pod: creating,
      events: [
        event("Pod", "FailedCreatePodSandBox", 5),
        event("Job", "SuccessfulCreate", 1),
      ],
      verdict: "unstartable",
    },
    {
      name: "ContainerCreating with Pulling events",
      job: amdJob({ active: 1 }),
      pod: creating,
      events: [event("Pod", "Scheduled", 170), event("Pod", "Pulling", 160)],
      verdict: "wait",
    },
    {
      name: "Pulling after an older FailedCreatePodSandBox",
      job: amdJob({ active: 1 }),
      pod: creating,
      events: [
        event("Pod", "FailedCreatePodSandBox", 150),
        event("Pod", "Pulling", 140),
      ],
      verdict: "wait",
    },
  ])("$name: $verdict", ({ job, pod, events, verdict }) => {
    expect(classifyGpuJobBoot({ job, pod, events, now: NOW })).toBe(verdict);
  });

  it("pins the window, the selector and the free-ports text", () => {
    expect(AMD_BOOT_WATCHDOG_SECONDS).toBe(180);
    expect(AMD_GPU_JOB_SELECTOR).toBe(
      "app=game-streamer,5stack-gpu-vendor=amd",
    );
    expect(FREE_PORTS_WAIT_SUBSTRING).toBe("didn't have free ports");
  });
});

describe("GameStreamerService AMD boot watchdog", () => {
  let service: GameStreamerService;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let loggingService: { getJobBootDiagnostics: jest.Mock };
  let teardown: Record<string, jest.SpyInstance>;

  const config = {
    get: (key: string) =>
      key === "gameServers"
        ? { namespace: "test", gameStreamerImage: "5stack/game-streamer:test" }
        : ({} as any),
  };

  const listedJob = (
    name: string,
    labels: Record<string, string>,
    node = "node-amd",
    ageSeconds = 600,
  ): V1Job => ({
    metadata: {
      name,
      labels: { app: "game-streamer", "5stack-gpu-vendor": "amd", ...labels },
      creationTimestamp: new Date(Date.now() - ageSeconds * 1000),
    },
    spec: {
      template: {
        spec: {
          containers: [],
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: "kubernetes.io/hostname",
                        operator: "In",
                        values: [node],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    status: { active: 1 },
  });

  // The diagnostics of a Job whose pod never appeared: unstartable.
  const noPod = (
    job: V1Job,
  ): Awaited<ReturnType<LoggingService["getJobBootDiagnostics"]>> => ({
    status: "Creating",
    detail: "Waiting for Kubernetes to create the match server pod.",
    terminal: false,
    job,
    pod: null,
    events: [],
  });

  const sweep = () => service["reapUnstartableGpuJobs"]();

  beforeEach(() => {
    listNamespacedJob.mockReset();
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    hasura = {
      query: jest.fn().mockResolvedValue({ match_demo_sessions: [] }),
      mutation: jest.fn(),
    };
    loggingService = { getJobBootDiagnostics: jest.fn() };

    service = new GameStreamerService(
      logger as any,
      config as any,
      hasura as any,
      { query: jest.fn(), transaction: jest.fn() } as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      loggingService as any,
      { claim: jest.fn(), release: jest.fn() } as any,
      { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
    );

    teardown = {
      stopLive: jest.spyOn(service, "stopLive").mockResolvedValue(undefined),
      stopDemoSessionById: jest
        .spyOn(service, "stopDemoSessionById")
        .mockResolvedValue(undefined),
      killBatchHighlightsPod: jest
        .spyOn(service, "killBatchHighlightsPod")
        .mockResolvedValue(undefined),
      killNadeRenderPod: jest
        .spyOn(service, "killNadeRenderPod")
        .mockResolvedValue(undefined),
      cancelBakeShaders: jest
        .spyOn(service, "cancelBakeShaders")
        .mockResolvedValue(undefined),
      deleteJob: jest
        .spyOn(service as any, "deleteJob")
        .mockResolvedValue(undefined),
    };
  });

  const expectOnlyTeardown = (helper: string, args: unknown[]) => {
    for (const [name, spy] of Object.entries(teardown)) {
      if (name === helper) {
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(...args);
      } else {
        expect(spy).not.toHaveBeenCalled();
      }
    }
  };

  it("lists only AMD game-streamer Jobs, and does nothing when there are none", async () => {
    listNamespacedJob.mockResolvedValue({ items: [] });

    await sweep();

    expect(listNamespacedJob).toHaveBeenCalledTimes(1);
    expect(listNamespacedJob).toHaveBeenCalledWith({
      namespace: "test",
      labelSelector: "app=game-streamer,5stack-gpu-vendor=amd",
    });
    expect(loggingService.getJobBootDiagnostics).not.toHaveBeenCalled();
    expectOnlyTeardown("none", []);
  });

  it.each<{
    role: string;
    labels: Record<string, string>;
    helper: string;
    args: unknown[];
  }>([
    {
      role: "live",
      labels: { "match-id": "match-1" },
      helper: "stopLive",
      args: ["match-1"],
    },
    {
      role: "demo",
      labels: { "match-id": "match-1", "session-id": "session-1" },
      helper: "stopDemoSessionById",
      args: ["session-1", "gs-job"],
    },
    {
      role: "batch-highlights",
      labels: {
        "match-id": "match-1",
        "match-map-id": "map-1",
        "match-map-demo-id": "demo-1",
      },
      helper: "killBatchHighlightsPod",
      args: ["map-1", "demo-1"],
    },
    {
      role: "nade-previews",
      labels: { "match-id": "match-1", "utility-map": "de_mirage" },
      helper: "killNadeRenderPod",
      args: ["gs-job"],
    },
    {
      role: "warm-shaders",
      labels: { "match-id": "node-amd", "node-id": "node-amd" },
      helper: "cancelBakeShaders",
      args: ["node-amd"],
    },
    {
      role: "create-clips",
      labels: { "match-id": "match-1" },
      helper: "deleteJob",
      args: ["gs-job"],
    },
    {
      role: "an-unknown-role",
      labels: { "match-id": "match-1" },
      helper: "deleteJob",
      args: ["gs-job"],
    },
  ])(
    "ends an unstartable $role Job through $helper with its labels",
    async ({ role, labels, helper, args }) => {
      const job = listedJob("gs-job", { role, ...labels });
      listNamespacedJob.mockResolvedValue({ items: [job] });
      loggingService.getJobBootDiagnostics.mockResolvedValue(noPod(job));

      await sweep();

      expect(loggingService.getJobBootDiagnostics).toHaveBeenCalledWith(
        "gs-job",
      );
      expectOnlyTeardown(helper, args);
      expect(logger.warn).toHaveBeenCalledWith(
        "[gpu-watchdog] ending AMD Job gs-job on node node-amd: Waiting for Kubernetes to create the match server pod.",
      );
    },
  );

  it.each([
    GameStreamerService.NADE_RENDER_JOB_NAME,
    GameStreamerService.GetLegacyNadeRenderJobName("de_nuke"),
  ])("ends the nade Job %s by its own name", async (name) => {
    const job = listedJob(name, {
      role: "nade-previews",
      "match-id": "match-1",
      "utility-map": "de_mirage",
    });
    listNamespacedJob.mockResolvedValue({ items: [job] });
    loggingService.getJobBootDiagnostics.mockResolvedValue(noPod(job));

    await sweep();

    expectOnlyTeardown("killNadeRenderPod", [name]);
  });

  it("names the newest event as the reason", async () => {
    const job = listedJob("gs-live-match-1", {
      role: "live",
      "match-id": "match-1",
    });
    listNamespacedJob.mockResolvedValue({ items: [job] });
    loggingService.getJobBootDiagnostics.mockResolvedValue({
      ...noPod(job),
      pod: {
        metadata: { name: "gs-live-match-1-x7k2p" },
        spec: { containers: [], nodeName: "node-amd" },
        status: {
          phase: "Pending",
          containerStatuses: [
            {
              name: "live",
              image: "5stack/game-streamer:test",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: { waiting: { reason: "ImagePullBackOff" } },
            },
          ],
        },
      },
      events: [
        {
          metadata: { name: "a" },
          involvedObject: { kind: "Pod", name: "gs-live-match-1-x7k2p" },
          reason: "Pulling",
          message: 'Pulling image "5stack/game-streamer:test"',
          lastTimestamp: new Date(Date.now() - 200_000),
        },
        {
          metadata: { name: "b" },
          involvedObject: { kind: "Pod", name: "gs-live-match-1-x7k2p" },
          reason: "Failed",
          message: "Error: ImagePullBackOff",
          lastTimestamp: new Date(Date.now() - 20_000),
        },
      ],
    });

    await sweep();

    expect(logger.warn).toHaveBeenCalledWith(
      "[gpu-watchdog] ending AMD Job gs-live-match-1 on node node-amd: Failed: Error: ImagePullBackOff",
    );
    expectOnlyTeardown("stopLive", ["match-1"]);
  });

  it("reads diagnostics only for unfinished Jobs past the window, and leaves a waiting Job alone", async () => {
    const finished = {
      ...listedJob("gs-done", { role: "live", "match-id": "match-1" }),
      status: { failed: 1 },
    };
    const young = listedJob(
      "gs-young",
      { role: "live", "match-id": "match-2" },
      "node-amd",
      30,
    );
    const ports = listedJob("gs-ports", {
      role: "live",
      "match-id": "match-3",
    });
    listNamespacedJob.mockResolvedValue({ items: [finished, young, ports] });
    loggingService.getJobBootDiagnostics.mockResolvedValue({
      ...noPod(ports),
      pod: {
        metadata: { name: "gs-ports-x7k2p" },
        status: {
          phase: "Pending",
          conditions: [
            {
              type: "PodScheduled",
              status: "False",
              reason: "Unschedulable",
              message: FREE_PORTS,
            },
          ],
        },
      },
    });

    await sweep();

    expect(loggingService.getJobBootDiagnostics).toHaveBeenCalledTimes(1);
    expect(loggingService.getJobBootDiagnostics).toHaveBeenCalledWith(
      "gs-ports",
    );
    expectOnlyTeardown("none", []);
  });

  it("keeps going when one teardown throws", async () => {
    const live = listedJob("gs-live", { role: "live", "match-id": "match-1" });
    const nades = listedJob(
      "gs-nades-queue",
      {
        role: "nade-previews",
        "match-id": "match-2",
        "utility-map": "de_nuke",
      },
      "node-amd-2",
    );
    listNamespacedJob.mockResolvedValue({ items: [live, nades] });
    loggingService.getJobBootDiagnostics.mockImplementation(
      async (name: string) => noPod(name === "gs-live" ? live : nades),
    );
    teardown.stopLive.mockRejectedValue(new Error("kube api down"));

    await expect(sweep()).resolves.toBeUndefined();

    expect(teardown.stopLive).toHaveBeenCalledWith("match-1");
    expect(teardown.killNadeRenderPod).toHaveBeenCalledWith("gs-nades-queue");
    expect(logger.warn).toHaveBeenCalledWith(
      "[gpu-watchdog] teardown of AMD Job gs-live on node node-amd failed: kube api down",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[gpu-watchdog] ending AMD Job gs-nades-queue on node node-amd-2: Waiting for Kubernetes to create the match server pod.",
    );
  });

  it("skips a Job whose diagnostics fail or that is already gone, and checks the rest", async () => {
    const broken = listedJob("gs-broken", {
      role: "live",
      "match-id": "match-1",
    });
    const gone = listedJob("gs-gone", { role: "live", "match-id": "match-2" });
    const bake = listedJob("gs-bake", {
      role: "warm-shaders",
      "match-id": "node-amd",
      "node-id": "node-amd",
    });
    listNamespacedJob.mockResolvedValue({ items: [broken, gone, bake] });
    loggingService.getJobBootDiagnostics.mockImplementation(
      async (name: string) => {
        if (name === "gs-broken") {
          throw new Error("jobs.batch is forbidden");
        }
        return name === "gs-gone" ? { ...noPod(gone), job: null } : noPod(bake);
      },
    );

    await expect(sweep()).resolves.toBeUndefined();

    expect(loggingService.getJobBootDiagnostics).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      "[gpu-watchdog] boot diagnostics of AMD Job gs-broken failed: jobs.batch is forbidden",
    );
    expectOnlyTeardown("cancelBakeShaders", ["node-amd"]);
  });

  it("logs and returns when the Job list fails", async () => {
    listNamespacedJob.mockRejectedValue(new Error("jobs.batch is forbidden"));

    await expect(sweep()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "[gpu-watchdog] listJobs failed: jobs.batch is forbidden",
    );
    expect(loggingService.getJobBootDiagnostics).not.toHaveBeenCalled();
    expectOnlyTeardown("none", []);
  });

  it("runs first in reapIdleDemoSessions, and its failure skips none of the other sweeps", async () => {
    const watchdog = jest
      .spyOn(service as any, "reapUnstartableGpuJobs")
      .mockRejectedValue(new Error("sweep exploded"));
    const orphans = jest
      .spyOn(service as any, "reapOrphanDemoK8sResources")
      .mockResolvedValue(undefined);
    const claims = jest
      .spyOn(service as any, "reconcileSteamClaims")
      .mockResolvedValue(undefined);
    hasura.query.mockResolvedValue({
      match_demo_sessions: [
        {
          id: "session-1",
          k8s_job_name: "gs-demo-session-1",
          last_activity_at: "2026-10-01T11:00:00Z",
        },
      ],
    });

    await expect(service.reapIdleDemoSessions()).resolves.toBeUndefined();

    expect(watchdog).toHaveBeenCalledTimes(1);
    expect(watchdog.mock.invocationCallOrder[0]).toBeLessThan(
      hasura.query.mock.invocationCallOrder[0],
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[gpu-watchdog] sweep failed: sweep exploded",
    );
    expect(teardown.stopDemoSessionById).toHaveBeenCalledWith(
      "session-1",
      "gs-demo-session-1",
    );
    expect(orphans).toHaveBeenCalledTimes(1);
    expect(claims).toHaveBeenCalledTimes(1);
  });
});
