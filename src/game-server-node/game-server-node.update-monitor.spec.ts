const createNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const readNamespacedPodLog = jest.fn();
const listNamespacedPod = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    createNamespacedJob = createNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    readNamespacedPodLog = readNamespacedPodLog;
    listNamespacedPod = listNamespacedPod;
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
}));

import { PassThrough, Writable } from "stream";
import { GameServerNodeService } from "./game-server-node.service";

describe("GameServerNodeService — CS2 update status", () => {
  const NODE_ID = "ab907991-4059-44c1-a122-fafdce97b70b";
  const JOB_NAME = GameServerNodeService.GET_UPDATE_JOB_NAME(NODE_ID);
  const CSGO_JOB_NAME = GameServerNodeService.GET_UPDATE_JOB_NAME(
    NODE_ID,
    "csgo",
  );
  const PROGRESS =
    "Update state (0x81) verifying install, progress: 49.12 (16106127360 / 32788426035)";

  let service: GameServerNodeService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let loggingService: {
    getJob: jest.Mock;
    getJobPod: jest.Mock;
    getLogsForPod: jest.Mock;
  };
  let notifications: { send: jest.Mock };
  let events: Array<string>;

  const runningJob = {
    metadata: { name: JOB_NAME, uid: "uid-running" },
    status: { active: 1 },
  };
  const runningPod = {
    metadata: { name: `${JOB_NAME}-abcde` },
    spec: { containers: [{ name: "update-cs-server" }] },
    status: { phase: "Running" },
  };
  const failedJob = {
    metadata: { name: JOB_NAME, uid: "uid-failed" },
    status: {
      failed: 2,
      conditions: [{ type: "Failed", status: "True" }],
    },
  };
  let redisKeys: Set<string>;
  let nodeRows: Array<Record<string, unknown>>;
  const redis = {
    set: jest.fn(async (key: string) => {
      if (redisKeys.has(key)) {
        return null;
      }
      redisKeys.add(key);
      return "OK";
    }),
    exists: jest.fn(async (key: string) => (redisKeys.has(key) ? 1 : 0)),
  };
  const recorded = <T extends { metadata: { uid: string } }>(job: T) => {
    redisKeys.add(`update-result-recorded:${job.metadata.uid}`);
    return job;
  };

  const logLine = (log: string) =>
    JSON.stringify({ pod: runningPod.metadata.name, log });

  const statusWrites = (column = "update_status") =>
    postgres.query.mock.calls
      .filter(([sql]) => new RegExp(`SET ${column} = \\$2`).test(sql))
      .map(([, params]) => params[1]);

  const terminalWrites = () =>
    events.filter((event) => event.startsWith("terminal"));

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    createNamespacedJob.mockReset().mockResolvedValue({});
    deleteNamespacedJob.mockReset().mockResolvedValue({});
    readNamespacedPodLog.mockReset().mockResolvedValue("");
    listNamespacedPod.mockReset().mockResolvedValue({ items: [] });
    redisKeys = new Set();
    nodeRows = [];
    events = [];

    hasura = {
      query: jest.fn(),
      mutation: jest.fn(),
    };
    postgres = {
      query: jest.fn(async (sql: string, params?: Array<unknown>) => {
        if (/^\s*SELECT/.test(sql)) {
          return nodeRows;
        }
        if (/update_failed_at = now\(\)/.test(sql)) {
          events.push("terminal:failed");
          return [{ id: NODE_ID }];
        }
        if (/update_status = NULL/.test(sql)) {
          events.push("terminal:succeeded");
        }
        if (/update_status = \$2/.test(sql) && params?.[1] === null) {
          events.push("terminal:status");
        }
        return [];
      }),
    };
    loggingService = {
      getJob: jest.fn(),
      getJobPod: jest.fn(),
      getLogsForPod: jest.fn(),
    };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };

    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const config = {
      get: (key: string) =>
        key === "gameServers" ? { namespace: "5stack" } : {},
    };

    service = new GameServerNodeService(
      logger as any,
      config as any,
      hasura as any,
      { getConnection: () => redis } as any,
      loggingService as any,
      notifications as any,
      {
        resolveGameServerPluginImage: jest
          .fn()
          .mockResolvedValue("ghcr.io/5stackgg/game-server:latest"),
      } as any,
      {} as any,
      postgres as any,
      {} as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("clears the status once the job is gone even when the log follow never ends", async () => {
    loggingService.getJob
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValue(null);
    loggingService.getJobPod
      .mockResolvedValueOnce(runningPod)
      .mockResolvedValue(undefined);
    loggingService.getLogsForPod.mockImplementation(
      (_pod: unknown, stream: Writable) => {
        stream.write(logLine(PROGRESS));
        return new Promise(() => {});
      },
    );

    let finished = false;
    void service.monitorUpdateStatus(NODE_ID).then(() => {
      finished = true;
    });

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(statusWrites()).toEqual(["verifying install 49%", null]);
    expect(finished).toBe(true);
  });

  it("does not let a slow progress write land after the terminal write", async () => {
    let releaseProgress: () => void = () => {};
    postgres.query.mockImplementationOnce(() => {
      events.push("progress:start");
      return new Promise<void>((resolve) => {
        releaseProgress = () => {
          events.push("progress:end");
          resolve();
        };
      });
    });

    loggingService.getJob.mockResolvedValueOnce(runningJob).mockResolvedValue({
      metadata: { name: JOB_NAME },
      status: { succeeded: 1 },
    });
    loggingService.getJobPod.mockResolvedValue(runningPod);
    loggingService.getLogsForPod.mockImplementation(
      async (_pod: unknown, stream: PassThrough) => {
        stream.write(logLine(PROGRESS));
        stream.end();
      },
    );

    void service.monitorUpdateStatus(NODE_ID);

    await jest.advanceTimersByTimeAsync(10 * 1000);
    releaseProgress();
    await jest.advanceTimersByTimeAsync(10 * 1000);

    expect(terminalWrites()).toHaveLength(1);
    expect(events.indexOf("progress:end")).toBeLessThan(
      events.indexOf(terminalWrites()[0]),
    );
  });

  it("writes only the newest status from a replayed log tail", async () => {
    loggingService.getJob
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValue(null);
    loggingService.getJobPod
      .mockResolvedValueOnce(runningPod)
      .mockResolvedValue(undefined);
    loggingService.getLogsForPod.mockImplementation(
      async (_pod: unknown, stream: PassThrough) => {
        stream.write(
          [47, 48, 49]
            .map((progress) =>
              logLine(
                `Update state (0x81) verifying install, progress: ${progress}.00 (1 / 2)`,
              ),
            )
            .join(""),
        );
        stream.end();
      },
    );

    const monitor = service.monitorUpdateStatus(NODE_ID);
    await jest.advanceTimersByTimeAsync(10 * 1000);
    await monitor;

    expect(statusWrites()).toEqual(["verifying install 49%", null]);
  });

  it("does not report a failure while the job is between a failed pod and its retry", async () => {
    loggingService.getJob
      .mockResolvedValueOnce({
        metadata: { name: JOB_NAME },
        status: { failed: 1, active: 0 },
      })
      .mockResolvedValue({
        metadata: { name: JOB_NAME },
        status: { failed: 1, succeeded: 1 },
      });
    loggingService.getJobPod.mockResolvedValue({
      ...runningPod,
      status: { phase: "Failed" },
    });

    const monitor = service.monitorUpdateStatus(NODE_ID);
    await jest.advanceTimersByTimeAsync(10 * 1000);
    await monitor;

    expect(notifications.send).not.toHaveBeenCalled();
    expect(terminalWrites()).toEqual(["terminal:succeeded"]);
  });

  it("records a failed update, notifies once, and keeps the job for its logs", async () => {
    loggingService.getJob.mockResolvedValue(failedJob);
    loggingService.getJobPod.mockResolvedValue({
      ...runningPod,
      status: { phase: "Failed" },
    });

    await service.monitorUpdateStatus(NODE_ID);

    expect(terminalWrites()).toEqual(["terminal:failed"]);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(deleteNamespacedJob).not.toHaveBeenCalled();

    await service.monitorUpdateStatus(NODE_ID);

    expect(terminalWrites()).toEqual(["terminal:failed"]);
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it("records a retry's failure separately from the job it replaced", async () => {
    loggingService.getJob.mockResolvedValue(failedJob);
    loggingService.getJobPod.mockResolvedValue(undefined);

    await service.monitorUpdateStatus(NODE_ID);

    loggingService.getJob.mockResolvedValue({
      ...failedJob,
      metadata: { name: JOB_NAME, uid: "uid-retry-failed" },
    });
    await service.monitorUpdateStatus(NODE_ID);

    expect(terminalWrites()).toEqual(["terminal:failed", "terminal:failed"]);
    expect(notifications.send).toHaveBeenCalledTimes(2);
  });

  it("does not let a kept csgo failure touch a running cs2 update", async () => {
    nodeRows = [
      {
        id: NODE_ID,
        update_status: "downloading 12%",
        csgo_update_status: null,
      },
    ];
    loggingService.getJob.mockImplementation(async (name: string) =>
      name === CSGO_JOB_NAME
        ? recorded({
            ...failedJob,
            metadata: { name: CSGO_JOB_NAME, uid: "uid-csgo-failed" },
          })
        : runningJob,
    );
    loggingService.getJobPod.mockImplementation(async (name: string) =>
      name === CSGO_JOB_NAME
        ? { ...runningPod, status: { phase: "Failed" } }
        : runningPod,
    );
    const monitor = jest
      .spyOn(service, "monitorUpdateStatus")
      .mockResolvedValue(undefined);

    await service.reconcileUpdateStatuses();
    await service.reconcileUpdateStatuses();

    expect(monitor.mock.calls).toEqual([
      [NODE_ID, "cs2"],
      [NODE_ID, "cs2"],
    ]);
    expect(statusWrites()).toEqual([]);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("clears a stale status when only a recorded, kept job is left", async () => {
    nodeRows = [
      {
        id: NODE_ID,
        update_status: "verifying install 49%",
        csgo_update_status: null,
      },
    ];
    loggingService.getJob.mockImplementation(async (name: string) =>
      name === JOB_NAME ? recorded(failedJob) : null,
    );
    loggingService.getJobPod.mockResolvedValue(undefined);
    const monitor = jest
      .spyOn(service, "monitorUpdateStatus")
      .mockResolvedValue(undefined);

    await service.reconcileUpdateStatuses();

    expect(monitor).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual([null]);
  });

  it("keeps one log follow open while the update keeps logging", async () => {
    let streamEnded = false;
    loggingService.getJob.mockImplementation(async () =>
      streamEnded ? null : runningJob,
    );
    loggingService.getJobPod.mockImplementation(async () =>
      streamEnded ? undefined : runningPod,
    );
    loggingService.getLogsForPod.mockImplementation(
      async (_pod: unknown, stream: PassThrough) => {
        let progress = 0;
        const ticker = setInterval(() => {
          if (stream.destroyed) {
            clearInterval(ticker);
            return;
          }
          progress += 10;
          if (progress > 90) {
            clearInterval(ticker);
            streamEnded = true;
            stream.end();
            return;
          }
          stream.write(
            logLine(
              `Update state (0x81) verifying install, progress: ${progress}.00 (1 / 2)`,
            ),
          );
        }, 20 * 1000);
      },
    );

    const monitor = service.monitorUpdateStatus(NODE_ID);
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    await monitor;

    expect(loggingService.getLogsForPod).toHaveBeenCalledTimes(1);
    expect(statusWrites().at(-1)).toBeNull();
  });

  it("looks again after a k8s error instead of leaving the status frozen", async () => {
    loggingService.getJob
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue({
        metadata: { name: JOB_NAME, uid: "uid-succeeded" },
        status: { succeeded: 1 },
      });
    loggingService.getJobPod.mockResolvedValue(undefined);

    await service.monitorUpdateStatus(NODE_ID);

    expect(postgres.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/update_failed_at = NULL/),
      [NODE_ID],
    );

    await jest.advanceTimersByTimeAsync(15 * 1000);

    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(/update_failed_at = NULL,\s+update_error = NULL/),
      [NODE_ID],
    );
  });

  it("keeps a succeeded job for its logs and clears a previous failure", async () => {
    loggingService.getJob.mockResolvedValue({
      metadata: { name: JOB_NAME, uid: "uid-succeeded" },
      status: { succeeded: 1 },
    });
    loggingService.getJobPod.mockResolvedValue(undefined);

    await service.monitorUpdateStatus(NODE_ID);

    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(/update_failed_at = NULL,\s+update_error = NULL/),
      [NODE_ID],
    );
    expect(deleteNamespacedJob).not.toHaveBeenCalled();

    await service.monitorUpdateStatus(NODE_ID);

    expect(terminalWrites()).toEqual(["terminal:succeeded"]);
  });

  it("does not report steamcmd's closing unknown state as the update status", async () => {
    let succeeded = false;
    loggingService.getJob.mockImplementation(async () =>
      succeeded
        ? {
            metadata: { name: JOB_NAME, uid: "uid-succeeded" },
            status: { succeeded: 1 },
          }
        : runningJob,
    );
    loggingService.getJobPod.mockResolvedValue(runningPod);
    loggingService.getLogsForPod.mockImplementation(
      async (_pod: unknown, stream: PassThrough) => {
        stream.write(
          [
            "\u001b[0m Update state (0x81) verifying update, progress: 2.27 (1669999610 / 73471564417)",
            "\u001b[0m Update state (0x0) unknown, progress: 0.00 (0 / 0)",
          ]
            .map(logLine)
            .join(""),
        );
        setTimeout(() => {
          stream.write(logLine("\u001b[0mSuccess! App '730' fully installed."));
          succeeded = true;
          stream.end();
        }, 1000);
      },
    );

    const monitor = service.monitorUpdateStatus(NODE_ID);
    await jest.advanceTimersByTimeAsync(10 * 1000);
    await monitor;

    expect(statusWrites()).toEqual(["verifying update 2%", "Finishing"]);
    expect(terminalWrites()).toEqual(["terminal:succeeded"]);
  });

  it("treats a pod orphaned by a deleted job as no update", async () => {
    const orphanedPod = { ...runningPod, status: { phase: "Succeeded" } };
    loggingService.getJob.mockResolvedValue(null);
    loggingService.getJobPod.mockResolvedValue(orphanedPod);

    let finished = false;
    void service.monitorUpdateStatus(NODE_ID).then(() => {
      finished = true;
    });
    await jest.advanceTimersByTimeAsync(60 * 1000);

    expect(finished).toBe(true);
    expect(statusWrites()).toEqual([null]);

    nodeRows = [
      { id: NODE_ID, update_status: "unknown 0%", csgo_update_status: null },
    ];
    const monitor = jest
      .spyOn(service, "monitorUpdateStatus")
      .mockResolvedValue(undefined);

    await service.reconcileUpdateStatuses();

    expect(monitor).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual([null, null]);
  });

  it("reconciles a stuck status on a disabled node", async () => {
    nodeRows = [
      {
        id: NODE_ID,
        enabled: false,
        update_status: "unknown 0%",
        csgo_update_status: null,
      },
    ];
    loggingService.getJob.mockResolvedValue(null);

    await service.reconcileUpdateStatuses();

    expect(postgres.query.mock.calls[0][0]).toMatch(
      /WHERE enabled\s+OR update_status IS NOT NULL\s+OR csgo_update_status IS NOT NULL/,
    );
    expect(statusWrites()).toEqual([null]);
  });

  it("leaves the status alone when a retry replaced the succeeded job", async () => {
    loggingService.getJob
      .mockResolvedValueOnce({
        metadata: { name: JOB_NAME, uid: "uid-succeeded" },
        status: { succeeded: 1 },
      })
      .mockResolvedValue(runningJob);
    loggingService.getJobPod.mockResolvedValue(undefined);

    await service.monitorUpdateStatus(NODE_ID);

    expect(terminalWrites()).toEqual([]);
  });

  it("keeps the last lines of a failed update's log", async () => {
    loggingService.getJob.mockResolvedValue(failedJob);
    loggingService.getJobPod.mockResolvedValue({
      ...runningPod,
      status: { phase: "Failed" },
    });
    readNamespacedPodLog.mockResolvedValue(
      [
        "---Downloading Depot 2347773 (2/3) manifest 4470192286501839716---",
        "[depot 2347773] 2731 MB / 3010 MB (90%) downloaded (19807 files)...",
        "",
        "\u001b[0mDepot 2347773 download did not complete. Exiting.",
        "",
      ].join("\n"),
    );

    await service.monitorUpdateStatus(NODE_ID);

    expect(readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: runningPod.metadata.name }),
    );
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(/update_failed_at = now\(\),\s+update_error = \$2/),
      [
        NODE_ID,
        [
          "---Downloading Depot 2347773 (2/3) manifest 4470192286501839716---",
          "[depot 2347773] 2731 MB / 3010 MB (90%) downloaded (19807 files)...",
          "Depot 2347773 download did not complete. Exiting.",
        ].join("\n"),
      ],
    );
  });

  it("still records a failure whose log can't be read", async () => {
    loggingService.getJob.mockResolvedValue(failedJob);
    loggingService.getJobPod.mockResolvedValue({
      ...runningPod,
      status: { phase: "Failed" },
    });
    readNamespacedPodLog.mockRejectedValue(new Error("pod is gone"));

    await service.monitorUpdateStatus(NODE_ID);

    expect(terminalWrites()).toEqual(["terminal:failed"]);
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(/update_error = \$2/),
      [NODE_ID, null],
    );
  });

  it("writes a CS:GO update to CS:GO's own columns", async () => {
    loggingService.getJob
      .mockResolvedValueOnce({
        ...runningJob,
        metadata: { name: CSGO_JOB_NAME, uid: "uid-csgo" },
      })
      .mockResolvedValue({
        metadata: { name: CSGO_JOB_NAME, uid: "uid-csgo" },
        status: { succeeded: 1 },
      });
    loggingService.getJobPod.mockResolvedValue(runningPod);
    loggingService.getLogsForPod.mockImplementation(
      async (_pod: unknown, stream: PassThrough) => {
        stream.write(logLine(PROGRESS));
        stream.end();
      },
    );

    const monitor = service.monitorUpdateStatus(NODE_ID, "csgo");
    await jest.advanceTimersByTimeAsync(10 * 1000);
    await monitor;

    expect(statusWrites("csgo_update_status")).toEqual([
      "verifying install 49%",
    ]);
    expect(statusWrites()).toEqual([]);
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /SET csgo_update_status = NULL,\s+csgo_update_failed_at = NULL,\s+csgo_update_error = NULL/,
      ),
      [NODE_ID],
    );
  });

  it("clears a stale CS:GO status while CS2 keeps updating", async () => {
    nodeRows = [
      {
        id: NODE_ID,
        update_status: "downloading 12%",
        csgo_update_status: "Initializing",
      },
    ];
    loggingService.getJob.mockImplementation(async (name: string) =>
      name === CSGO_JOB_NAME ? null : runningJob,
    );
    const monitor = jest
      .spyOn(service, "monitorUpdateStatus")
      .mockResolvedValue(undefined);

    await service.reconcileUpdateStatuses();

    expect(monitor.mock.calls).toEqual([[NODE_ID, "cs2"]]);
    expect(statusWrites()).toEqual([]);
    expect(statusWrites("csgo_update_status")).toEqual([null]);
  });

  it("replaces a failed job when the update is retried instead of only watching it", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: {
        build_id: 25537370,
        pinned_version: null,
        update_status: null,
        pin_plugin_version: null,
        pin_plugin_runtime: null,
      },
    });
    jest.spyOn(service as any, "createVolumes").mockResolvedValue(undefined);
    jest.spyOn(service, "monitorUpdateStatus").mockResolvedValue(undefined);
    loggingService.getJob.mockResolvedValue(failedJob);
    loggingService.getJobPod.mockResolvedValue({
      ...runningPod,
      status: { phase: "Failed" },
    });

    await service.updateCsServer(NODE_ID, true);

    expect(deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: JOB_NAME,
        body: expect.objectContaining({
          propagationPolicy: "Background",
          preconditions: { uid: "uid-failed" },
        }),
      }),
    );
    expect(createNamespacedJob).toHaveBeenCalledTimes(1);
    expect(deleteNamespacedJob.mock.invocationCallOrder[0]).toBeLessThan(
      createNamespacedJob.mock.invocationCallOrder[0],
    );
    expect(
      createNamespacedJob.mock.calls[0][0].body.spec.ttlSecondsAfterFinished,
    ).toBe(7 * 24 * 60 * 60);
  });

  it("starts a CS:GO update on CS:GO's columns", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: {
        build_id: 25537370,
        pinned_version: null,
        update_status: null,
        pin_plugin_version: null,
        pin_plugin_runtime: null,
      },
    });
    jest.spyOn(service as any, "createVolumes").mockResolvedValue(undefined);
    jest.spyOn(service, "monitorUpdateStatus").mockResolvedValue(undefined);
    loggingService.getJob.mockResolvedValue(null);

    await service.updateCsServer(NODE_ID, false, "csgo");

    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /SET csgo_update_status = 'Initializing',\s+csgo_update_failed_at = NULL,\s+csgo_update_error = NULL/,
      ),
      [NODE_ID],
    );
  });

  const removableNode = (fields: Record<string, unknown> = {}) => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: {
        pin_plugin_version: null,
        pin_plugin_runtime: null,
        enabled_for_match_making: true,
        accepting_new_matches: false,
        ...fields,
      },
    });
    jest.spyOn(service as any, "createVolumes").mockResolvedValue(undefined);
    return jest
      .spyOn(service, "monitorUpdateStatus")
      .mockResolvedValue(undefined);
  };

  const claimPod = (name: string, phase: string, claimName: string) => ({
    metadata: { name },
    spec: {
      volumes: [{ name: "files", persistentVolumeClaim: { claimName } }],
    },
    status: { phase },
  });

  it("removes CS2 through its update job, with its depot copy", async () => {
    const monitor = removableNode();
    loggingService.getJob.mockResolvedValue(
      recorded({
        metadata: { name: JOB_NAME, uid: "uid-done" },
        status: { succeeded: 1 },
      }),
    );

    await service.removeCsServer(NODE_ID, "cs2");

    expect(deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: JOB_NAME,
        body: expect.objectContaining({ preconditions: { uid: "uid-done" } }),
      }),
    );
    const job = createNamespacedJob.mock.calls[0][0].body;
    expect(job.metadata).toEqual({
      name: JOB_NAME,
      labels: { "5stack.gg/removes-game": "true" },
    });
    const script = job.spec.template.spec.containers[0].command.at(-1);
    expect(script).toContain(
      "find /serverdata/serverfiles -mindepth 1 -delete",
    );
    expect(script).toContain(
      "rm -rf /serverdata/steamcmd/linux32/steamapps/content/app_730",
    );
    expect(
      job.spec.template.spec.volumes.map(
        (volume: any) => volume.persistentVolumeClaim.claimName,
      ),
    ).toEqual([`serverfiles-${NODE_ID}-claim`, `steamcmd-${NODE_ID}-claim`]);
    expect(job.spec.activeDeadlineSeconds).toBe(30 * 60);
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /SET update_status = 'Removing',\s+update_failed_at = NULL,\s+update_error = NULL\s+WHERE/,
      ),
      [NODE_ID],
    );
    expect(monitor).toHaveBeenCalledWith(NODE_ID, "cs2");
  });

  it("removes CS:GO from its own volume and columns", async () => {
    const monitor = removableNode();
    loggingService.getJob.mockResolvedValue(null);

    await service.removeCsServer(NODE_ID, "csgo");

    const job = createNamespacedJob.mock.calls[0][0].body;
    expect(job.metadata.name).toBe(CSGO_JOB_NAME);
    expect(job.spec.template.spec.containers[0].command.at(-1)).not.toContain(
      "steamcmd",
    );
    expect(
      job.spec.template.spec.volumes.map(
        (volume: any) => volume.persistentVolumeClaim.claimName,
      ),
    ).toEqual([`serverfiles-csgo-${NODE_ID}-claim`]);
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /SET csgo_update_status = 'Removing',\s+csgo_update_failed_at = NULL,\s+csgo_update_error = NULL\s+WHERE/,
      ),
      [NODE_ID],
    );
    expect(monitor).toHaveBeenCalledWith(NODE_ID, "csgo");
  });

  it("refuses to remove CS2 while the node takes matches, but not CS:GO", async () => {
    removableNode({ accepting_new_matches: true });
    loggingService.getJob.mockResolvedValue(null);

    await expect(service.removeCsServer(NODE_ID, "cs2")).rejects.toThrow(
      `Turn off Matchmaking or Accepting matches on ${NODE_ID} before removing CS2`,
    );
    expect(createNamespacedJob).not.toHaveBeenCalled();

    await service.removeCsServer(NODE_ID, "csgo");
    expect(createNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it("removes CS2 from a node out of matchmaking that still accepts", async () => {
    removableNode({
      enabled_for_match_making: false,
      accepting_new_matches: true,
    });
    loggingService.getJob.mockResolvedValue(null);

    await service.removeCsServer(NODE_ID, "cs2");

    expect(createNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it("refuses to remove a game while its install or update is running", async () => {
    removableNode();
    loggingService.getJob.mockResolvedValue(runningJob);

    await expect(service.removeCsServer(NODE_ID, "cs2")).rejects.toThrow(
      "Wait for the running CS2 job",
    );

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(createNamespacedJob).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("refuses to remove a game while a live pod uses its files", async () => {
    removableNode();
    loggingService.getJob.mockResolvedValue(null);
    const finished = claimPod(
      "update-cs-server-done",
      "Succeeded",
      `serverfiles-${NODE_ID}-claim`,
    );
    const csgoServer = claimPod(
      "csgo-server",
      "Running",
      `serverfiles-csgo-${NODE_ID}-claim`,
    );
    listNamespacedPod.mockResolvedValue({
      items: [
        claimPod("m-match", "Running", `serverfiles-${NODE_ID}-claim`),
        claimPod("m-queued", "Pending", `serverfiles-${NODE_ID}-claim`),
        finished,
        csgoServer,
      ],
    });

    await expect(service.removeCsServer(NODE_ID, "cs2")).rejects.toThrow(
      `CS2 is in use on ${NODE_ID}: m-match, m-queued`,
    );
    expect(createNamespacedJob).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();

    listNamespacedPod.mockResolvedValue({ items: [finished, csgoServer] });

    await service.removeCsServer(NODE_ID, "cs2");

    expect(createNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it("refuses to remove a game it doesn't know", async () => {
    removableNode();

    await expect(service.removeCsServer(NODE_ID, "cs3")).rejects.toThrow(
      "Unknown game cs3",
    );
    expect(createNamespacedJob).not.toHaveBeenCalled();
  });

  it("shows a removal as Removing while its pod starts and runs", async () => {
    const removalJob = {
      ...runningJob,
      metadata: {
        ...runningJob.metadata,
        labels: { "5stack.gg/removes-game": "true" },
      },
    };
    loggingService.getJob
      .mockResolvedValueOnce(removalJob)
      .mockResolvedValueOnce(removalJob)
      .mockResolvedValue({
        ...removalJob,
        status: { succeeded: 1 },
      });
    loggingService.getJobPod
      .mockResolvedValueOnce({ ...runningPod, status: { phase: "Pending" } })
      .mockResolvedValue(runningPod);
    loggingService.getLogsForPod.mockImplementation(
      async (_pod: unknown, stream: PassThrough) => {
        stream.write(logLine("---Removing CS2---"));
        stream.end();
      },
    );

    const monitor = service.monitorUpdateStatus(NODE_ID);
    await jest.advanceTimersByTimeAsync(30 * 1000);
    await monitor;

    expect(statusWrites()).toEqual(["Removing"]);
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /SET update_status = NULL,\s+build_id = NULL\s+WHERE/,
      ),
      [NODE_ID],
    );
  });

  it("reports a failed removal as a removal", async () => {
    loggingService.getJob.mockResolvedValue({
      ...failedJob,
      metadata: {
        ...failedJob.metadata,
        labels: { "5stack.gg/removes-game": "true" },
      },
    });
    loggingService.getJobPod.mockResolvedValue({
      ...runningPod,
      status: { phase: "Failed" },
    });

    await service.monitorUpdateStatus(NODE_ID);

    const writes = postgres.query.mock.calls.map(([sql]) => sql);
    expect(writes).toContainEqual(
      expect.stringMatching(/SET update_status = NULL\s+WHERE/),
    );
    expect(writes.some((sql) => /update_failed_at|build_id/.test(sql))).toBe(
      false,
    );
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledWith(
      "GameUpdate",
      expect.objectContaining({
        title: "Game Removal Failed",
        message: expect.stringContaining("Removing CS2 failed"),
      }),
    );
  });
});

describe("GameServerNodeService update logs", () => {
  it("names each game's update job from its log service", () => {
    expect(GameServerNodeService.updateLogJobName("cs-update:node.a")).toBe(
      "update-cs-server-node-a",
    );
    expect(GameServerNodeService.updateLogJobName("csgo-update:node.a")).toBe(
      "update-csgo-server-node-a",
    );
    expect(GameServerNodeService.updateLogJobName("api")).toBeNull();
  });

  it("keeps the last non-empty lines without colour codes", () => {
    expect(
      GameServerNodeService.lastLogLines("one\n\u001b[0mtwo\n\n  \nthree\n", 2),
    ).toBe("two\nthree");
    expect(GameServerNodeService.lastLogLines("\n\n", 3)).toBeNull();
  });
});
