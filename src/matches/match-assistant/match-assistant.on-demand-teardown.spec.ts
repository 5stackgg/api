const listNamespacedPod = jest.fn();
const deleteNamespacedPod = jest.fn();
const createNamespacedJob = jest.fn();
const readNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const exec = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    createNamespacedJob = createNamespacedJob;
    readNamespacedJob = readNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = listNamespacedPod;
    deleteNamespacedPod = deleteNamespacedPod;
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {
    exec = exec;
  },
}));

import { MatchAssistantService } from "./match-assistant.service";
import { StopOnDemandServer } from "../jobs/StopOnDemandServer";
import { FailedToCreateOnDemandServer } from "../errors/FailedToCreateOnDemandServer";

describe("MatchAssistantService — on-demand server teardown", () => {
  let service: MatchAssistantService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let cache: { lock: jest.Mock };
  let queue: { add: jest.Mock };
  let pluginRuntime: {
    resolveGameServerPluginImage: jest.Mock;
    resolvePracticeServerImage: jest.Mock;
    supportsPractice: jest.Mock;
  };
  let scheduledMatchesQueue: { add: jest.Mock; getDelayed: jest.Mock };
  let logger: {
    warn: jest.Mock;
    log: jest.Mock;
    error: jest.Mock;
    verbose: jest.Mock;
  };

  const notFound = { code: 404 };

  const activeJob = (uid = "uid-1") => ({
    metadata: { name: "m-match-1", uid },
    status: { active: 1 },
  });

  const pod = (
    phase: string,
    state: Record<string, unknown>,
    jobUid = "uid-1",
    name = "m-match-1-abcde",
  ) => ({
    metadata: { name, ownerReferences: [{ kind: "Job", uid: jobUid }] },
    spec: { containers: [{ name: "game-server" }] },
    status: {
      phase,
      containerStatuses: [{ name: "game-server", state }],
    },
  });

  const runningPod = (jobUid = "uid-1", name?: string) =>
    pod("Running", { running: {} }, jobUid, name);
  const terminatingPod = (jobUid = "uid-1") => {
    const terminating = runningPod(jobUid);
    return {
      ...terminating,
      metadata: { ...terminating.metadata, deletionTimestamp: new Date() },
    };
  };
  const creatingPod = (jobUid = "uid-1", name?: string) =>
    pod("Pending", { waiting: { reason: "ContainerCreating" } }, jobUid, name);

  const serverReleases = () =>
    hasura.mutation.mock.calls
      .map(([mutation]) => mutation?.update_servers)
      .filter(Boolean);

  beforeEach(() => {
    for (const fn of [
      listNamespacedPod,
      deleteNamespacedPod,
      createNamespacedJob,
      readNamespacedJob,
      deleteNamespacedJob,
      exec,
    ]) {
      fn.mockReset();
    }

    listNamespacedPod.mockResolvedValue({ items: [] });
    deleteNamespacedPod.mockResolvedValue({});
    createNamespacedJob.mockResolvedValue({});
    readNamespacedJob.mockRejectedValue(notFound);
    deleteNamespacedJob.mockResolvedValue({});
    exec.mockResolvedValue({});

    hasura = {
      query: jest.fn(async (request: any) => {
        if (request.matches_by_pk) {
          return { matches_by_pk: { server_error: null } };
        }
        return {};
      }),
      mutation: jest.fn(async () => ({})),
    };
    cache = {
      lock: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    };
    queue = { add: jest.fn() };
    pluginRuntime = {
      resolveGameServerPluginImage: jest.fn(
        async () => "ghcr.io/5stackgg/game-server-css:latest",
      ),
      resolvePracticeServerImage: jest.fn(
        async () => "ghcr.io/5stackgg/game-server-sw:latest",
      ),
      supportsPractice: jest.fn(async () => true),
    };
    scheduledMatchesQueue = {
      add: jest.fn(),
      getDelayed: jest.fn(async (): Promise<unknown[]> => []),
    };
    logger = {
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      verbose: jest.fn(),
    };

    service = new MatchAssistantService(
      logger as any,
      {} as any,
      cache as any,
      {
        get: jest.fn((key: string) =>
          key === "gameServers" ? { namespace: "test" } : {},
        ),
      } as any,
      hasura as any,
      { decrypt: jest.fn(async () => "rcon") } as any,
      { getJobBootDiagnostics: jest.fn() } as any,
      pluginRuntime as any,
      {
        resolveForServer: jest.fn(async (): Promise<null> => null),
        environmentFor: jest.fn((): unknown[] => []),
      } as any,
      queue as any,
      scheduledMatchesQueue as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
    );
  });

  describe("the graceful stop", () => {
    it("removes the Job when its pod never got to Running", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob())
        .mockRejectedValue(notFound);
      listNamespacedPod
        .mockResolvedValueOnce({ items: [creatingPod()] })
        .mockResolvedValueOnce({ items: [creatingPod()] })
        .mockResolvedValue({ items: [] });

      await service.stopOnDemandServer("match-1");

      expect(exec).not.toHaveBeenCalled();
      expect(deleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ name: "m-match-1", namespace: "test" }),
      );
    });

    // The scheduled-matches queue has one worker, and nothing reuses the name afterwards.
    it("does not hold the queue waiting for the Job to disappear", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob())
        .mockRejectedValue(notFound);
      listNamespacedPod
        .mockResolvedValueOnce({ items: [creatingPod()] })
        .mockResolvedValueOnce({ items: [creatingPod()] })
        .mockResolvedValue({ items: [] });

      await service.stopOnDemandServer("match-1");

      expect(readNamespacedJob).toHaveBeenCalledTimes(1);
    });

    it("signals a running game server and checks back that it stopped", async () => {
      readNamespacedJob.mockResolvedValue(activeJob("uid-1"));
      listNamespacedPod.mockResolvedValue({ items: [runningPod()] });

      await service.stopOnDemandServer("match-1");

      expect(exec).toHaveBeenCalledWith(
        "test",
        "m-match-1-abcde",
        "game-server",
        ["kill", "-SIGUSR1", "1"],
        expect.anything(),
        expect.anything(),
        expect.anything(),
        false,
      );
      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(scheduledMatchesQueue.add).toHaveBeenCalledWith(
        "StopOnDemandServer",
        {
          matchId: "match-1",
          jobName: "m-match-1",
          jobUid: "uid-1",
          signalledAt: expect.any(Number),
        },
        expect.objectContaining({ delay: 3 * 1000 }),
      );
    });

    it("tells its check which server the signalled pod was booted on", async () => {
      readNamespacedJob.mockResolvedValue({
        ...activeJob("uid-1"),
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: "game-server",
                  env: [{ name: "SERVER_ID", value: "server-1" }],
                },
              ],
            },
          },
        },
      });
      listNamespacedPod.mockResolvedValue({ items: [runningPod()] });

      await service.stopOnDemandServer("match-1");

      expect(scheduledMatchesQueue.add).toHaveBeenCalledWith(
        "StopOnDemandServer",
        expect.objectContaining({ serverId: "server-1" }),
        expect.anything(),
      );
    });

    it("leaves a Job that already finished alone, logs and all", async () => {
      readNamespacedJob.mockResolvedValue({
        metadata: { name: "m-match-1", uid: "uid-1" },
        status: {
          succeeded: 1,
          conditions: [{ type: "Complete", status: "True" }],
        },
      });
      listNamespacedPod.mockResolvedValue({
        items: [pod("Succeeded", { terminated: { exitCode: 0 } })],
      });

      await service.stopOnDemandServer("match-1");

      expect(exec).not.toHaveBeenCalled();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(scheduledMatchesQueue.add).not.toHaveBeenCalled();
    });

    // BullMQ only retries a job that throws.
    it("rethrows when Kubernetes cannot be reached, and keeps the reservation", async () => {
      const unavailable = Object.assign(new Error("connect ECONNREFUSED"), {
        code: 500,
      });
      readNamespacedJob.mockRejectedValue(unavailable);
      listNamespacedPod.mockRejectedValue(unavailable);

      await expect(service.stopOnDemandServer("match-1")).rejects.toThrow(
        "connect ECONNREFUSED",
      );

      expect(serverReleases()).toHaveLength(0);
    });
  });

  describe("checking back on a signalled server", () => {
    beforeEach(() => {
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches) {
          return {
            matches: [
              {
                id: "match-1",
                status: "Finished",
                server_id: null,
                options: { tv_delay: 0 },
              },
            ],
          };
        }
        if (request.servers) {
          return { servers: [] };
        }
        return {};
      });
    });

    it("removes the Job it signalled when it is still running", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      listNamespacedPod.mockResolvedValueOnce({
        items: [runningPod("uid-1")],
      });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(deleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ name: "m-match-1" }),
      );
    });

    it("deletes the Job only while it is still the one it signalled", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      listNamespacedPod.mockResolvedValueOnce({
        items: [runningPod("uid-1")],
      });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(deleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "m-match-1",
          body: expect.objectContaining({
            preconditions: { uid: "uid-1" },
            propagationPolicy: "Background",
          }),
        }),
      );
    });

    it("leaves a Job that replaced it between the read and the delete", async () => {
      readNamespacedJob.mockResolvedValueOnce(activeJob("uid-1"));
      deleteNamespacedJob.mockRejectedValue({ code: 409 });
      listNamespacedPod
        .mockResolvedValueOnce({ items: [runningPod("uid-1")] })
        .mockResolvedValue({
          items: [creatingPod("uid-2", "m-match-1-fghij")],
        });

      await expect(
        service.removeUnstoppedOnDemandServer("match-1", "uid-1"),
      ).resolves.toBe(true);

      expect(deleteNamespacedPod).not.toHaveBeenCalled();
    });

    it("removes only the pods that belonged to the Job it removed", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      const listed = {
        items: [
          runningPod("uid-1", "m-match-1-abcde"),
          creatingPod("uid-2", "m-match-1-fghij"),
        ],
      };
      listNamespacedPod
        .mockResolvedValueOnce(listed)
        .mockResolvedValueOnce(listed)
        .mockResolvedValue({ items: [] });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(
        deleteNamespacedPod.mock.calls.map(([request]) => request.name),
      ).toEqual(["m-match-1-abcde"]);
    });

    it("does not hold the queue waiting for the Job to disappear", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      listNamespacedPod.mockResolvedValueOnce({
        items: [runningPod("uid-1")],
      });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(readNamespacedJob).toHaveBeenCalledTimes(1);
    });

    it("leaves a Job created for a later assignment alone", async () => {
      readNamespacedJob.mockResolvedValue(activeJob("uid-2"));

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });

    it("leaves a Job that stopped the way it was asked to", async () => {
      readNamespacedJob.mockResolvedValue({
        metadata: { name: "m-match-1", uid: "uid-1" },
        status: { conditions: [{ type: "Complete", status: "True" }] },
      });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });

    const releasedEndedMatchServer = () =>
      expect(serverReleases()).toEqual([
        expect.objectContaining({
          __args: expect.objectContaining({
            where: {
              reserved_by_match_id: { _eq: "match-1" },
              current_match: {
                status: {
                  _in: expect.arrayContaining(["Canceled", "Finished"]),
                },
              },
            },
          }),
        }),
      ]);

    it("frees the ended match's server once its own server stopped", async () => {
      readNamespacedJob.mockResolvedValue({
        metadata: { name: "m-match-1", uid: "uid-1" },
        status: { conditions: [{ type: "Complete", status: "True" }] },
      });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      releasedEndedMatchServer();
    });

    it("frees the ended match's server once its Job is gone", async () => {
      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      releasedEndedMatchServer();
    });

    it("frees the ended match's server after removing a server that ignored the signal", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      listNamespacedPod.mockResolvedValueOnce({
        items: [runningPod("uid-1")],
      });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(deleteNamespacedJob).toHaveBeenCalled();
      expect(deleteNamespacedJob.mock.invocationCallOrder[0]).toBeLessThan(
        hasura.mutation.mock.invocationCallOrder.at(-1)!,
      );
      releasedEndedMatchServer();
    });

    describe("once the server it signalled is gone", () => {
      let assignServer: jest.SpyInstance;
      let matchStatus: string;

      beforeEach(() => {
        matchStatus = "Finished";
        assignServer = jest
          .spyOn(service, "assignServer")
          .mockResolvedValue(undefined);
        hasura.query.mockImplementation(async (request: any) => {
          if (request.matches_by_pk) {
            return { matches_by_pk: { status: matchStatus, source: "5stack" } };
          }
          if (request.matches?.__args?.where?.status) {
            return { matches: [{ id: "match-2" }] };
          }
          if (request.matches) {
            return {
              matches: [
                { id: "match-1", status: matchStatus, server_id: null },
              ],
            };
          }
          if (request.servers?.__args?.where?.id) {
            return { servers: [{ id: "server-1", region: "USE" }] };
          }
          if (request.servers) {
            return { servers: [] };
          }
          return {};
        });
      });

      const checkBack = () =>
        service.removeUnstoppedOnDemandServer(
          "match-1",
          "uid-1",
          "m-match-1",
          Date.now() - 3 * 1000,
          "server-1",
        );

      const wakes = () =>
        queue.add.mock.calls.filter(([name]) => name === "AssignWaitingMatch");

      // On its own queue, with its own retries, off the single scheduled-matches worker.
      it("queues the ended match's server for the oldest waiting match", async () => {
        await checkBack();

        expect(wakes()).toEqual([
          ["AssignWaitingMatch", { region: "USE" }, expect.anything()],
        ]);
        expect(assignServer).not.toHaveBeenCalled();
      });

      it("queues a server a match moved off for the oldest waiting match", async () => {
        matchStatus = "Live";

        await checkBack();

        expect(serverReleases()).toHaveLength(0);
        expect(wakes()).toHaveLength(1);
      });

      it("queues nothing while the server is still exiting", async () => {
        readNamespacedJob.mockResolvedValue(activeJob("uid-1"));
        listNamespacedPod.mockResolvedValue({ items: [runningPod("uid-1")] });

        await checkBack();

        expect(wakes()).toHaveLength(0);
      });

      // The stop job retries when queueing fails, and by then the row is already free.
      it("queues the server it was told the match ended on, though freeing it found nothing", async () => {
        hasura.mutation.mockResolvedValue({
          update_servers: { returning: [] },
        });

        await service.stopEndedMatchServer("match-1", "server-1");

        expect(wakes()).toHaveLength(1);
      });
    });

    it("checks again while the server it signalled is still exiting", async () => {
      readNamespacedJob.mockResolvedValue(activeJob("uid-1"));
      listNamespacedPod.mockResolvedValue({ items: [runningPod("uid-1")] });

      await expect(
        service.removeUnstoppedOnDemandServer(
          "match-1",
          "uid-1",
          "m-match-1",
          Date.now() - 3 * 1000,
        ),
      ).resolves.toBe(false);

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(serverReleases()).toHaveLength(0);
    });

    it("removes the server it signalled once it has had two minutes to exit", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      listNamespacedPod
        .mockResolvedValueOnce({ items: [runningPod("uid-1")] })
        .mockResolvedValue({ items: [] });

      await expect(
        service.removeUnstoppedOnDemandServer(
          "match-1",
          "uid-1",
          "m-match-1",
          Date.now() - 2 * 60 * 1000,
        ),
      ).resolves.toBe(true);

      expect(deleteNamespacedJob).toHaveBeenCalled();
      expect(serverReleases()).toHaveLength(1);
    });

    it("leaves a Job whose server already exited, logs and all", async () => {
      readNamespacedJob.mockResolvedValue(activeJob("uid-1"));
      listNamespacedPod.mockResolvedValue({
        items: [pod("Succeeded", { terminated: { exitCode: 0 } })],
      });

      await expect(
        service.removeUnstoppedOnDemandServer(
          "match-1",
          "uid-1",
          "m-match-1",
          Date.now() - 3 * 1000,
        ),
      ).resolves.toBe(true);

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(serverReleases()).toHaveLength(1);
    });

    it("keeps the server while a pod of its deleted Job is still terminating", async () => {
      listNamespacedPod.mockResolvedValue({ items: [terminatingPod("uid-1")] });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(serverReleases()).toHaveLength(0);
    });

    it("leaves the server of a match that went on to a newer Job", async () => {
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches_by_pk) {
          return {
            matches_by_pk: { status: "Live", source: "5stack" },
          };
        }
        if (request.matches) {
          return {
            matches: [{ id: "match-1", status: "Live", server_id: "server-2" }],
          };
        }
        if (request.servers) {
          return {
            servers: [{ id: "server-2", reserved_by_match_id: "match-1" }],
          };
        }
        return {};
      });
      readNamespacedJob.mockResolvedValue(activeJob("uid-2"));
      listNamespacedPod.mockResolvedValue({ items: [runningPod("uid-2")] });

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(serverReleases()).toHaveLength(0);
    });

    it("keeps the server when Kubernetes cannot be read", async () => {
      readNamespacedJob.mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED"), { code: 500 }),
      );

      await expect(
        service.removeUnstoppedOnDemandServer("match-1", "uid-1"),
      ).rejects.toThrow("connect ECONNREFUSED");

      expect(serverReleases()).toHaveLength(0);
    });
  });

  describe("a queued stop that runs late", () => {
    let matchStatus: string;
    let reservations: Array<{
      id: string;
      reserved_by_match_id: string;
      is_dedicated?: boolean;
    }>;

    beforeEach(() => {
      matchStatus = "Live";
      reservations = [];
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches_by_pk) {
          return {
            matches_by_pk: { status: matchStatus, server_error: null },
          };
        }
        if (request.matches) {
          return {
            matches: [
              {
                id: "match-1",
                status: matchStatus,
                server_id: reservations.at(0)?.id ?? null,
                options: { tv_delay: 0 },
              },
            ],
          };
        }
        if (request.servers) {
          const dedicated = request.servers.__args.where.is_dedicated?._eq;
          return {
            servers: reservations.filter(
              (server) =>
                dedicated === undefined ||
                (server.is_dedicated ?? false) === dedicated,
            ),
          };
        }
        return {};
      });
    });

    const runStop = () =>
      new StopOnDemandServer(service).process({
        data: { matchId: "match-1" },
      } as any);

    const signalled = () =>
      exec.mock.calls.filter(([, , , command]) => command.includes("-SIGUSR1"));

    it("leaves the server of a match that was started again alone", async () => {
      reservations = [{ id: "server-2", reserved_by_match_id: "match-1" }];
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-2"))
        .mockRejectedValue(notFound);
      listNamespacedPod
        .mockResolvedValueOnce({ items: [creatingPod("uid-2")] })
        .mockResolvedValue({ items: [] });

      await runStop();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(serverReleases()).toHaveLength(0);
    });

    it.each([
      "Scheduled",
      "WaitingForCheckIn",
      "Veto",
      "WaitingForServer",
      "Live",
    ])(
      "stops the old server of a match back in %s that holds no server",
      async (status) => {
        matchStatus = status;
        readNamespacedJob.mockResolvedValue(activeJob("uid-1"));
        listNamespacedPod.mockResolvedValue({ items: [runningPod("uid-1")] });

        await runStop();

        expect(signalled()).toHaveLength(1);
        expect(scheduledMatchesQueue.add).toHaveBeenCalledWith(
          "StopOnDemandServer",
          {
            matchId: "match-1",
            jobName: "m-match-1",
            jobUid: "uid-1",
            signalledAt: expect.any(Number),
          },
          expect.anything(),
        );
      },
    );

    it("stops the old on-demand server of a match now on a dedicated one", async () => {
      reservations = [
        {
          id: "dedicated-1",
          reserved_by_match_id: "match-1",
          is_dedicated: true,
        },
      ];
      readNamespacedJob.mockResolvedValue(activeJob("uid-1"));
      listNamespacedPod.mockResolvedValue({ items: [runningPod("uid-1")] });

      await runStop();

      expect(signalled()).toHaveLength(1);
    });

    it("leaves a server booted for the match after it checked", async () => {
      matchStatus = "WaitingForCheckIn";
      let rebooted = false;
      const answer = hasura.query.getMockImplementation()!;
      hasura.query.mockImplementation(async (request: any) => {
        const result = await answer(request);
        if (request.servers) {
          rebooted = true;
        }
        return result;
      });
      readNamespacedJob.mockImplementation(async () =>
        activeJob(rebooted ? "uid-2" : "uid-1"),
      );
      listNamespacedPod.mockImplementation(async () => ({
        items: [rebooted ? creatingPod("uid-2") : runningPod("uid-1")],
      }));

      await runStop();

      expect(signalled()).toHaveLength(0);
      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(deleteNamespacedPod).not.toHaveBeenCalled();
    });

    it("keeps an ended match's server while the server it signalled is still running", async () => {
      matchStatus = "Finished";
      readNamespacedJob.mockResolvedValue(activeJob("uid-1"));
      listNamespacedPod.mockResolvedValue({ items: [runningPod("uid-1")] });

      await runStop();

      expect(signalled()).toHaveLength(1);
      expect(serverReleases()).toHaveLength(0);
    });

    it("frees an ended match's server straight away when nothing of it is left running", async () => {
      matchStatus = "Finished";
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      listNamespacedPod
        .mockResolvedValueOnce({ items: [creatingPod("uid-1")] })
        .mockResolvedValue({ items: [] });

      await runStop();

      expect(deleteNamespacedJob).toHaveBeenCalled();
      expect(serverReleases()).toHaveLength(1);
    });

    it("keeps an ended match's server while a pod of its deleted Job is still terminating", async () => {
      matchStatus = "Finished";
      listNamespacedPod.mockResolvedValue({ items: [terminatingPod("uid-1")] });

      await runStop();

      expect(serverReleases()).toHaveLength(0);
    });

    it("rethrows when Kubernetes cannot be reached, and frees nothing", async () => {
      matchStatus = "Finished";
      readNamespacedJob.mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED"), { code: 500 }),
      );

      await expect(runStop()).rejects.toThrow("connect ECONNREFUSED");

      expect(serverReleases()).toHaveLength(0);
    });

    it("frees only rows still held by a match that has ended", async () => {
      matchStatus = "Canceled";

      await runStop();

      const [release] = serverReleases();

      expect(release.__args.where).toEqual({
        reserved_by_match_id: { _eq: "match-1" },
        current_match: {
          status: { _in: expect.arrayContaining(["Canceled", "Finished"]) },
        },
      });
    });
  });

  describe("counting free on-demand servers", () => {
    const heldPod = {
      metadata: { name: "m-match-2-abcde" },
      spec: {
        nodeName: "node-1",
        containers: [
          {
            name: "game-server",
            env: [
              { name: "SERVER_ID", value: "server-1" },
              { name: "SERVER_PORT", value: "27015" },
            ],
          },
        ],
      },
      status: { phase: "Running" },
    };

    beforeEach(() => {
      listNamespacedPod.mockResolvedValue({ items: [heldPod] });
    });

    it("leaves out a server a match pod still holds, as the hand-out does", async () => {
      hasura.query.mockResolvedValue({
        servers_aggregate: { aggregate: { count: 1 } },
      });

      await service.countFreeOnDemandServers("USE");

      const [[request]] = hasura.query.mock.calls;
      expect(request.servers_aggregate.__args.where._and).toContainEqual({
        _not: {
          _or: [
            { game_server_node_id: { _eq: "node-1" }, port: { _eq: 27015 } },
          ],
        },
      });
    });

    it("offers no render node whose free server a match pod still holds", async () => {
      const postgres = (service as any).postgres.query as jest.Mock;
      postgres.mockResolvedValue([]);

      await service.renderNodes();

      expect(postgres).toHaveBeenCalledWith(
        expect.stringContaining("unnest($1::text[], $2::int[])"),
        [["node-1"], [27015]],
      );
    });
  });

  describe("handing a freed server to a waiting match", () => {
    let assignOnDemandServer: jest.SpyInstance;
    let outcomes: Record<string, boolean | "retry">;
    let waiting: Array<{ id: string; source?: string }>;
    let reservations: Array<{
      id: string;
      reserved_by_match_id: string;
      boot_status: string | null;
    }>;

    const attempts = () =>
      assignOnDemandServer.mock.calls.map(([matchId]) => matchId);

    // The real assignServer, retry and all, down to the on-demand attempt.
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ["Date"] });
      outcomes = {};
      assignOnDemandServer = jest
        .spyOn(service as any, "assignOnDemandServer")
        .mockImplementation(async (matchId: string) => {
          const outcome = outcomes[matchId] ?? true;
          if (outcome === "retry") {
            throw new FailedToCreateOnDemandServer();
          }
          return outcome;
        });
      jest
        .spyOn(service as any, "assignDedicatedServer")
        .mockResolvedValue(false);
      waiting = [{ id: "match-a" }, { id: "match-b" }, { id: "match-c" }];
      reservations = [
        {
          id: "server-1",
          reserved_by_match_id: "match-a",
          boot_status: "Booting",
        },
      ];
      readNamespacedJob.mockImplementation(async ({ name }: any) => {
        if (name === "m-match-a") {
          return {
            metadata: {
              name,
              uid: "uid-a",
              creationTimestamp: new Date(),
            },
            status: { active: 1 },
          };
        }
        throw notFound;
      });
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches?.__args?.where?.status) {
          const excluded = request.matches.__args.where.source?._neq;
          return {
            matches: waiting.filter(
              (match) => (match.source ?? "5stack") !== excluded,
            ),
          };
        }
        if (request.matches) {
          const [id] = request.matches.__args.where.id._in;
          const reservation = reservations.find(
            (server) => server.reserved_by_match_id === id,
          );
          return {
            matches: [
              {
                id,
                status: "WaitingForServer",
                server_id: reservation?.id ?? null,
              },
            ],
          };
        }
        if (request.servers) {
          const [id] = request.servers.__args.where.reserved_by_match_id._in;
          return {
            servers: reservations.filter(
              (server) => server.reserved_by_match_id === id,
            ),
          };
        }
        if (request.matches_by_pk) {
          return {
            matches_by_pk: {
              id: request.matches_by_pk.__args.id,
              status: "WaitingForServer",
              region: "USE",
              source: "5stack",
              server_error: null,
              options: { prefer_dedicated_server: false },
            },
          };
        }
        return {};
      });
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it("re-arms the boot check of a booting match it goes past", async () => {
      await service.assignWaitingMatch("USE");

      expect(queue.add).toHaveBeenCalledWith(
        "CheckOnDemandServerJob",
        { matchId: "match-a" },
        expect.objectContaining({ jobId: "match.match-a.server" }),
      );
    });

    it("goes past a match whose own server is still booting", async () => {
      await service.assignWaitingMatch("USE");

      expect(attempts()).toEqual(["match-b"]);
    });

    it("takes a match whose booting server's Job is gone", async () => {
      readNamespacedJob.mockRejectedValue(notFound);

      await service.assignWaitingMatch("USE");

      expect(attempts()).toEqual(["match-a"]);
    });

    it("takes a match whose server has waited ten minutes for its first ping", async () => {
      reservations[0].boot_status = "WaitingForPing";
      readNamespacedJob.mockResolvedValue({
        metadata: {
          name: "m-match-a",
          uid: "uid-a",
          creationTimestamp: new Date(Date.now() - 11 * 60 * 1000),
        },
        status: { active: 1 },
      });

      await service.assignWaitingMatch("USE");

      expect(attempts()).toEqual(["match-a"]);
    });

    it("goes past a booting match when its Job cannot be read", async () => {
      readNamespacedJob.mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED"), { code: 500 }),
      );

      await service.assignWaitingMatch("USE");

      expect(attempts()).toEqual(["match-b"]);
    });

    // A practice match waits for a server only once its session has failed.
    it("goes past a practice match", async () => {
      reservations = [];
      waiting = [{ id: "practice-1", source: "practice" }, { id: "match-b" }];

      await service.assignWaitingMatch("USE");

      expect(attempts()).toEqual(["match-b"]);
    });

    // Its retries will take the server; another match trying too would race it.
    it("leaves the server to the oldest match while its attempt retries", async () => {
      reservations = [];
      outcomes = { "match-a": "retry" };

      await expect(service.assignWaitingMatch("USE")).resolves.toBe(1);

      expect(attempts()).toEqual(["match-a"]);
      expect(jest.getTimerCount()).toBe(1);
    });

    it("stops when the oldest match finds no server free", async () => {
      reservations = [];
      outcomes = { "match-a": false };

      await expect(service.assignWaitingMatch("USE", 2)).resolves.toBe(0);

      expect(attempts()).toEqual(["match-a"]);
    });

    it("places as many waiting matches as it has servers, each tried once", async () => {
      reservations = [];

      await expect(service.assignWaitingMatch("USE", 2)).resolves.toBe(2);

      expect(attempts()).toEqual(["match-a", "match-b"]);
    });

    it("goes to the oldest waiting match when none is booting", async () => {
      reservations = [];

      await service.assignWaitingMatch("USE");

      expect(attempts()).toEqual(["match-a"]);
    });

    // Another attempt for the same match may have placed it meanwhile.
    it("only says a match is waiting for a server once retries run out if it still has none", async () => {
      outcomes = { "match-a": "retry" };

      await service.assignServer("match-a", 10);

      const [waitingWrite] = hasura.mutation.mock.calls
        .map(([mutation]) => mutation?.update_matches)
        .filter(
          (update) => update?.__args?._set?.status === "WaitingForServer",
        );
      expect(waitingWrite.__args.where).toEqual(
        expect.objectContaining({ server_id: { _is_null: true } }),
      );
    });
  });

  describe("removing a server outright", () => {
    it("deletes the Job before its pods", async () => {
      listNamespacedPod
        .mockResolvedValueOnce({ items: [runningPod()] })
        .mockResolvedValue({ items: [] });

      await service.stopOnDemandServer("match-1", { remove: true });

      expect(deleteNamespacedJob).toHaveBeenCalled();
      expect(deleteNamespacedPod).toHaveBeenCalled();
      expect(deleteNamespacedJob.mock.invocationCallOrder[0]).toBeLessThan(
        deleteNamespacedPod.mock.invocationCallOrder[0],
      );
    });

    it("waits for the pods to be gone, not just the Job", async () => {
      listNamespacedPod
        .mockResolvedValueOnce({ items: [runningPod()] })
        .mockResolvedValueOnce({ items: [runningPod()] })
        .mockResolvedValue({ items: [] });

      await service.stopOnDemandServer("match-1", { remove: true });

      expect(listNamespacedPod.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("removes a practice server under u- and one booted before that under m-", async () => {
      hasura.query.mockImplementation(async (request: any) => ({
        matches_by_pk: request.matches_by_pk?.source
          ? { source: "practice" }
          : { server_error: null },
      }));

      await service.stopOnDemandServer("match-1", { remove: true });

      expect(
        deleteNamespacedJob.mock.calls.map(([request]) => request.name),
      ).toEqual(["u-match-1", "m-match-1"]);
    });

    it("releases only the server it was given", async () => {
      await service.stopOnDemandServer("match-1", {
        remove: true,
        serverId: "server-1",
      });

      const [release] = serverReleases();

      expect(release.__args.where).toEqual({
        reserved_by_match_id: { _eq: "match-1" },
        id: { _eq: "server-1" },
      });
    });
  });

  describe("assigning an on-demand server", () => {
    let matchStatus: string;
    let matchSource: string;
    let serverIdWriteAffectedRows: number;
    let nodes: Array<Record<string, unknown>>;

    beforeEach(() => {
      matchStatus = "Live";
      matchSource = "5stack";
      serverIdWriteAffectedRows = 1;
      nodes = [
        {
          id: "node-1",
          build_id: 20000,
          pin_plugin_version: null,
          pin_plugin_runtime: null,
        },
      ];

      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches_by_pk?.match_maps) {
          return {
            matches_by_pk: {
              region: "USE",
              password: "secret",
              server_id: null,
              source: matchSource,
              max_players_per_lineup: 5,
              is_tournament_match: false,
              options: { type: "Competitive" },
              match_maps: [
                {
                  order: 1,
                  map: { name: "de_inferno", workshop_map_id: null },
                },
              ],
            },
          };
        }
        if (request.matches_by_pk?.server_error) {
          return { matches_by_pk: { server_error: null } };
        }
        if (request.matches_by_pk) {
          return {
            matches_by_pk: {
              id: "match-1",
              status: matchStatus,
              region: "USE",
              source: "5stack",
              options: { prefer_dedicated_server: false },
            },
          };
        }
        if (request.game_server_nodes) {
          return { game_server_nodes: nodes };
        }
        if (request.matches) {
          return { matches: [] };
        }
        if (request.servers) {
          return {
            servers: [
              {
                id: "server-1",
                label: "node-1:27015",
                host: "10.0.0.1",
                port: 27015,
                tv_port: 27020,
                api_password: "api",
                rcon_password: "encrypted",
                game_server_node: {
                  id: "node-1",
                  pin_plugin_version: null,
                  pin_plugin_runtime: null,
                  supports_cpu_pinning: false,
                },
                server_region: { is_lan: false, steam_relay: false },
              },
            ],
          };
        }
        if (request.settings_by_pk) {
          return { settings_by_pk: null };
        }
        return {};
      });

      hasura.mutation.mockImplementation(async (request: any) => {
        if (request.update_matches) {
          return {
            update_matches: { affected_rows: serverIdWriteAffectedRows },
          };
        }
        return {};
      });
    });

    // The assignment picks a server next, under the lock a woken match would need.
    it("hands the server it gives back to a waiting match only after picking its next one", async () => {
      const assignServer = jest
        .spyOn(service, "assignServer")
        .mockResolvedValue(undefined);
      const answer = hasura.query.getMockImplementation()!;
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches?.__args?.where?.status) {
          return { matches: [{ id: "match-2" }] };
        }
        if (request.servers?.__args?.where?.id?._in) {
          return { servers: [{ id: "server-9", region: "USE" }] };
        }
        return answer(request);
      });
      hasura.mutation.mockImplementation(async (request: any) => {
        if (request.update_servers) {
          return { update_servers: { returning: [{ id: "server-9" }] } };
        }
        if (request.update_matches) {
          return { update_matches: { affected_rows: 1 } };
        }
        return {};
      });

      await expect(
        (service as any).assignOnDemandServer("match-1", {
          preserveMatchStatus: true,
        }),
      ).resolves.toBe(true);

      expect(assignServer).not.toHaveBeenCalled();
      const wake = queue.add.mock.calls.findIndex(
        ([name]) => name === "AssignWaitingMatch",
      );
      expect(wake).toBeGreaterThanOrEqual(0);
      expect(queue.add.mock.invocationCallOrder[wake]).toBeGreaterThan(
        createNamespacedJob.mock.invocationCallOrder[0],
      );
    });

    describe("a match that already holds an on-demand server", () => {
      let bootStatus: string | null;

      beforeEach(() => {
        bootStatus = "Booting";
        const answer = hasura.query.getMockImplementation()!;
        hasura.query.mockImplementation(async (request: any) => {
          if (request.matches) {
            return {
              matches: [
                { id: "match-1", status: "Live", server_id: "server-1" },
              ],
            };
          }
          if (request.servers?.__args?.where?.reserved_by_match_id?._in) {
            return {
              servers: [
                {
                  id: "server-1",
                  reserved_by_match_id: "match-1",
                  boot_status: bootStatus,
                },
              ],
            };
          }
          return answer(request);
        });
      });

      // Nothing else would call startMatch if its check had died.
      it("re-arms the boot check of the server it leaves booting", async () => {
        readNamespacedJob.mockResolvedValue(activeJob("uid-1"));

        await service.assignServer("match-1");

        expect(queue.add).toHaveBeenCalledWith(
          "CheckOnDemandServerJob",
          { matchId: "match-1" },
          expect.objectContaining({ jobId: "match.match-1.server" }),
        );
      });

      it("keeps the server it is booting when it is woken again", async () => {
        readNamespacedJob.mockResolvedValue(activeJob("uid-1"));

        await service.assignServer("match-1");

        expect(deleteNamespacedJob).not.toHaveBeenCalled();
        expect(createNamespacedJob).not.toHaveBeenCalled();
      });

      it("is booted again when its booting server's Job is gone", async () => {
        await service.assignServer("match-1");

        expect(createNamespacedJob).toHaveBeenCalled();
      });

      // It may well take another server than the one it gave back.
      it("hands the server it failed to boot on to the next waiting match", async () => {
        bootStatus = "Failed";
        const answer = hasura.query.getMockImplementation()!;
        hasura.query.mockImplementation(async (request: any) =>
          request.servers?.__args?.where?.id?._in
            ? { servers: [{ id: "server-1", region: "USE" }] }
            : answer(request),
        );
        hasura.mutation.mockImplementation(async (request: any) => {
          if (request.update_servers) {
            return { update_servers: { returning: [{ id: "server-1" }] } };
          }
          if (request.update_matches) {
            return { update_matches: { affected_rows: 1 } };
          }
          return {};
        });

        await service.assignServer("match-1");

        expect(
          queue.add.mock.calls.filter(
            ([name]) => name === "AssignWaitingMatch",
          ),
        ).toEqual([
          ["AssignWaitingMatch", { region: "USE" }, expect.anything()],
        ]);
      });

      it("keeps the server it was given when the hand-off cannot be queued", async () => {
        bootStatus = "Failed";
        const answer = hasura.query.getMockImplementation()!;
        hasura.query.mockImplementation(async (request: any) =>
          request.servers?.__args?.where?.id?._in
            ? { servers: [{ id: "server-1", region: "USE" }] }
            : answer(request),
        );
        hasura.mutation.mockImplementation(async (request: any) => {
          if (request.update_servers) {
            return { update_servers: { returning: [{ id: "server-1" }] } };
          }
          if (request.update_matches) {
            return { update_matches: { affected_rows: 1 } };
          }
          return {};
        });
        queue.add.mockImplementation(async (name: string) => {
          if (name === "AssignWaitingMatch") {
            throw new Error("redis unavailable");
          }
        });

        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).resolves.toBe(true);
      });

      it("is booted again when its server failed to boot", async () => {
        bootStatus = "Failed";

        await service.assignServer("match-1");

        expect(createNamespacedJob).toHaveBeenCalled();
      });

      it("is booted again when it is rebooted", async () => {
        await expect(
          (service as any).assignOnDemandServer("match-1", {
            preserveMatchStatus: true,
          }),
        ).resolves.toBe(true);

        expect(createNamespacedJob).toHaveBeenCalled();
      });
    });

    describe("a server another match's pod is still on", () => {
      const otherMatchPod = (
        phase: string,
        deleting = false,
        serverId = "server-1",
      ) => ({
        metadata: {
          name: "m-match-2-abcde",
          ...(deleting ? { deletionTimestamp: new Date() } : {}),
        },
        spec: {
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: "kubernetes.io/hostname",
                        operator: "In",
                        values: ["node-1"],
                      },
                    ],
                  },
                ],
              },
            },
          },
          containers: [
            {
              name: "game-server",
              env: [
                { name: "SERVER_ID", value: serverId },
                { name: "SERVER_PORT", value: "27015" },
              ],
            },
          ],
        },
        status: { phase },
      });

      let matchPods: Array<unknown>;

      beforeEach(() => {
        matchPods = [];
        const answer = hasura.query.getMockImplementation()!;
        hasura.query.mockImplementation(async (request: any) =>
          request.servers?.__args?.where?._and?.[0]?._not?._or?.some(
            (slot: any) =>
              slot.game_server_node_id?._eq === "node-1" &&
              slot.port?._eq === 27015,
          )
            ? { servers: [] }
            : answer(request),
        );
        listNamespacedPod.mockImplementation(async (request: any) => {
          if (request.labelSelector === "app=game-server,role=match") {
            return { items: matchPods };
          }
          return { items: [] };
        });
      });

      it("asks only for match pods that have not finished", async () => {
        await (service as any).assignOnDemandServer("match-1");

        expect(listNamespacedPod).toHaveBeenCalledWith(
          expect.objectContaining({
            labelSelector: "app=game-server,role=match",
            fieldSelector: "status.phase!=Succeeded,status.phase!=Failed",
          }),
        );
      });

      it("is not handed out under the new row a node edit made for its port", async () => {
        matchPods = [otherMatchPod("Running", false, "server-before-edit")];

        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).resolves.toBe(false);

        expect(createNamespacedJob).not.toHaveBeenCalled();
      });

      it("is not handed out while that pod runs", async () => {
        matchPods = [otherMatchPod("Running")];

        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).resolves.toBe(false);

        expect(createNamespacedJob).not.toHaveBeenCalled();
      });

      it("is not handed out while that pod is still terminating", async () => {
        matchPods = [otherMatchPod("Running", true)];

        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).resolves.toBe(false);

        expect(createNamespacedJob).not.toHaveBeenCalled();
      });

      it("is handed out once that pod has exited", async () => {
        matchPods = [otherMatchPod("Succeeded")];

        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).resolves.toBe(true);

        expect(createNamespacedJob).toHaveBeenCalled();
      });

      it("is not handed out when the pods cannot be listed", async () => {
        listNamespacedPod.mockImplementation(async (request: any) => {
          if (request.labelSelector === "app=game-server,role=match") {
            throw Object.assign(new Error("connect ECONNREFUSED"), {
              code: 500,
            });
          }
          return { items: [] };
        });

        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).rejects.toBeInstanceOf(FailedToCreateOnDemandServer);

        expect(createNamespacedJob).not.toHaveBeenCalled();
      });
    });

    it("says when it placed the match", async () => {
      await expect(service.assignServer("match-1")).resolves.toBe("placed");
    });

    it("says when it could not place the match", async () => {
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches_by_pk) {
          return {
            matches_by_pk: {
              id: "match-1",
              status: "Live",
              region: "USE",
              source: "5stack",
              server_error: null,
              options: { prefer_dedicated_server: false },
              match_maps: [
                {
                  order: 1,
                  map: { name: "de_inferno", workshop_map_id: null },
                },
              ],
            },
          };
        }
        if (request.game_server_nodes) {
          return { game_server_nodes: nodes };
        }
        return { matches: [], servers: [] };
      });

      await expect(service.assignServer("match-1")).resolves.toBe("unplaced");
    });

    it("does not look for a server for a match that already ended", async () => {
      matchStatus = "Canceled";

      const assignOnDemandServer = jest.spyOn(
        service as any,
        "assignOnDemandServer",
      );

      await service.assignServer("match-1");

      expect(assignOnDemandServer).not.toHaveBeenCalled();
      expect(createNamespacedJob).not.toHaveBeenCalled();
    });

    it("does not fall back to a dedicated server for a match that ended during the on-demand attempt", async () => {
      jest
        .spyOn(service as any, "assignOnDemandServer")
        .mockImplementation(async () => {
          matchStatus = "Canceled";
          return false;
        });
      const assignDedicatedServer = jest
        .spyOn(service as any, "assignDedicatedServer")
        .mockResolvedValue(true);

      await service.assignServer("match-1");

      expect(assignDedicatedServer).not.toHaveBeenCalled();
    });

    it("never creates a Job for a match that ended before the pool lock was taken", async () => {
      matchStatus = "Canceled";

      await expect(
        (service as any).assignOnDemandServer("match-1"),
      ).resolves.toBe(false);

      expect(createNamespacedJob).not.toHaveBeenCalled();
    });

    it("removes the Job it just created when the match ended mid-assignment", async () => {
      serverIdWriteAffectedRows = 0;

      await expect(
        (service as any).assignOnDemandServer("match-1"),
      ).resolves.toBe(false);

      const serverIdWrite = hasura.mutation.mock.calls
        .map(([mutation]) => mutation?.update_matches)
        .find((update) => update?.__args?._set?.server_id === "server-1");

      expect(serverIdWrite.__args.where.status._nin).toEqual(
        expect.arrayContaining(["Canceled", "Finished"]),
      );

      const created = createNamespacedJob.mock.invocationCallOrder[0];

      expect(
        deleteNamespacedJob.mock.invocationCallOrder.some(
          (order) => order > created,
        ),
      ).toBe(true);
      expect(serverReleases()).toContainEqual(
        expect.objectContaining({
          __args: expect.objectContaining({
            where: expect.objectContaining({
              reserved_by_match_id: { _eq: "match-1" },
            }),
          }),
        }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("keeps the server the match already points at when the boot check cannot be queued", async () => {
      queue.add.mockRejectedValue(new Error("redis unavailable"));

      await expect(
        (service as any).assignOnDemandServer("match-1"),
      ).rejects.toBeInstanceOf(FailedToCreateOnDemandServer);

      const created = createNamespacedJob.mock.invocationCallOrder[0];

      expect(
        deleteNamespacedJob.mock.invocationCallOrder.some(
          (order) => order > created,
        ),
      ).toBe(false);
      expect(
        serverReleases().filter((release) =>
          hasura.mutation.mock.invocationCallOrder.some(
            (order, index) =>
              order > created &&
              hasura.mutation.mock.calls[index][0]?.update_servers === release,
          ),
        ),
      ).toEqual([]);
    });

    it("labels the Job so a sweep can find it", async () => {
      await expect(
        (service as any).assignOnDemandServer("match-1"),
      ).resolves.toBe(true);

      const body = createNamespacedJob.mock.calls[0][0].body;
      const labels = {
        app: "game-server",
        role: "match",
        "match-id": "match-1",
      };

      expect(body.metadata.labels).toEqual(labels);
      expect(body.spec.template.metadata.labels).toEqual({
        job: "m-match-1",
        ...labels,
      });
    });

    it("tells the game server which match it runs, for its crash reports", async () => {
      await (service as any).assignOnDemandServer("match-1");

      const [container] =
        createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers;

      expect(container.env).toContainEqual({
        name: "MATCH_ID",
        value: "match-1",
      });
    });

    it("boots CS2 with workshop command filtering off", async () => {
      await (service as any).assignOnDemandServer("match-1");

      const [container] =
        createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers;
      const params = container.env.find(
        (entry: { name: string }) => entry.name === "EXTRA_GAME_PARAMS",
      );

      expect(params.value.split(" ")).toContain(
        "-disable_workshop_command_filtering",
      );
    });

    it("holds the pool lock past a teardown but not past the retries", async () => {
      await (service as any).assignOnDemandServer("match-1");

      const [key, , expires] = cache.lock.mock.calls[0];

      expect(key).toBe("get-on-demand-server:USE");
      expect(expires).toBeGreaterThanOrEqual(30);
      expect(expires).toBeLessThanOrEqual(45);
    });

    it("retries when another assignment holds the pool lock", async () => {
      cache.lock.mockRejectedValue(
        new Error(
          "Failed to acquire lock for get-on-demand-server:USE after 10 attempts",
        ),
      );

      await expect(
        (service as any).assignOnDemandServer("match-1"),
      ).rejects.toBeInstanceOf(FailedToCreateOnDemandServer);
    });

    describe("for practice", () => {
      beforeEach(() => {
        matchSource = "practice";
      });

      const bootedImage = () =>
        createNamespacedJob.mock.calls[0][0].body.spec.template.spec
          .containers[0].image;

      const serverQuery = () =>
        hasura.query.mock.calls
          .map(([request]) => request)
          .find((request) => request.servers?.__args?.where?.game_server_node)
          ?.servers;

      it("names its Job u-", async () => {
        await (service as any).assignOnDemandServer("match-1");

        expect(createNamespacedJob.mock.calls[0][0].body.metadata.name).toBe(
          "u-match-1",
        );
      });

      // The CounterStrikeSharp image refuses to boot one.
      it("boots it on the SwiftlyS2 image", async () => {
        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).resolves.toBe(true);

        expect(bootedImage()).toBe("ghcr.io/5stackgg/game-server-sw:latest");
        expect(pluginRuntime.resolvePracticeServerImage).toHaveBeenCalledWith(
          expect.objectContaining({ id: "node-1" }),
        );
        expect(
          pluginRuntime.resolveGameServerPluginImage,
        ).not.toHaveBeenCalled();
      });

      it("keeps a match on the node's own runtime", async () => {
        matchSource = "5stack";

        await (service as any).assignOnDemandServer("match-1");

        expect(bootedImage()).toBe("ghcr.io/5stackgg/game-server-css:latest");
        expect(pluginRuntime.resolvePracticeServerImage).not.toHaveBeenCalled();
        expect(pluginRuntime.supportsPractice).not.toHaveBeenCalled();
      });

      it("keeps the render image override for a render pod", async () => {
        (service as any).gameServerConfig = {
          namespace: "test",
          utilityRenderServerImage: "registry.local/game-server:render",
        };
        const query = hasura.query.getMockImplementation();
        hasura.query.mockImplementation(async (request: any) =>
          request.utility_practice_sessions
            ? { utility_practice_sessions: [{ id: "session-1" }] }
            : query(request),
        );
        (service as any).postgres.query = jest.fn(async (sql: string) =>
          sql.includes("gpu_busy_node_ids")
            ? [{ id: "node-1", region: "USE", gpu_only: false }]
            : [],
        );

        await (service as any).assignOnDemandServer("match-1");

        expect(bootedImage()).toBe("registry.local/game-server:render");
      });

      it("only takes a server on a node whose build SwiftlyS2 supports", async () => {
        nodes = [
          { id: "node-1", build_id: 20000 },
          { id: "node-2", build_id: 20001 },
        ];
        pluginRuntime.supportsPractice.mockImplementation(
          async (node: { id: string }) => node.id === "node-1",
        );

        await (service as any).assignOnDemandServer("match-1");

        expect(serverQuery().__args.where.game_server_node._and).toContainEqual(
          { id: { _in: ["node-1"] } },
        );
      });

      it("boots nothing when SwiftlyS2 supports no node's build", async () => {
        pluginRuntime.supportsPractice.mockResolvedValue(false);

        await expect(
          (service as any).assignOnDemandServer("match-1"),
        ).resolves.toBe(false);

        expect(createNamespacedJob).not.toHaveBeenCalled();
        expect(serverQuery()).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            "the SwiftlyS2 plugin does not support the CS2 build",
          ),
        );
      });
    });

    it("does not mistake a failure inside the lock for contention", async () => {
      hasura.query.mockImplementation(async (request: any) => {
        if (request.servers) {
          throw new Error("hasura unavailable");
        }
        if (request.game_server_nodes) {
          return { game_server_nodes: [{ id: "node-1" }] };
        }
        if (request.matches_by_pk?.match_maps) {
          return {
            matches_by_pk: {
              region: "USE",
              match_maps: [{ order: 1, map: { name: "de_inferno" } }],
            },
          };
        }
        return { matches_by_pk: { status: "Live", server_error: null } };
      });

      await expect(
        (service as any).assignOnDemandServer("match-1"),
      ).rejects.toThrow("hasura unavailable");
    });
  });
});
