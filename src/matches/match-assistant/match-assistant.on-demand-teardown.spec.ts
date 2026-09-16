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
      {
        resolveGameServerPluginImage: jest.fn(
          async () => "ghcr.io/5stackgg/game-server-sw:latest",
        ),
      } as any,
      {
        resolveForServer: jest.fn(async (): Promise<null> => null),
        environmentFor: jest.fn((): unknown[] => []),
      } as any,
      queue as any,
      scheduledMatchesQueue as any,
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
        { matchId: "match-1", jobUid: "uid-1" },
        expect.objectContaining({
          delay: MatchAssistantService.ON_DEMAND_SERVER_STOP_CHECK_DELAY_MS,
        }),
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

      await service.removeUnstoppedOnDemandServer("match-1", "uid-1");

      expect(deleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ name: "m-match-1" }),
      );
    });

    it("deletes the Job only while it is still the one it signalled", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);

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
      listNamespacedPod.mockResolvedValue({
        items: [creatingPod("uid-2", "m-match-1-fghij")],
      });

      await expect(
        service.removeUnstoppedOnDemandServer("match-1", "uid-1"),
      ).resolves.toBeUndefined();

      expect(deleteNamespacedPod).not.toHaveBeenCalled();
    });

    it("removes only the pods that belonged to the Job it removed", async () => {
      readNamespacedJob
        .mockResolvedValueOnce(activeJob("uid-1"))
        .mockRejectedValue(notFound);
      listNamespacedPod
        .mockResolvedValueOnce({
          items: [
            runningPod("uid-1", "m-match-1-abcde"),
            creatingPod("uid-2", "m-match-1-fghij"),
          ],
        })
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
  });

  describe("a queued stop that runs late", () => {
    let matchStatus: string;

    beforeEach(() => {
      matchStatus = "Live";
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches_by_pk) {
          return {
            matches_by_pk: { status: matchStatus, server_error: null },
          };
        }
        return {};
      });
    });

    const runStop = () =>
      new StopOnDemandServer(service).process({
        data: { matchId: "match-1" },
      } as any);

    it("leaves the server of a match that was started again alone", async () => {
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
    let serverIdWriteAffectedRows: number;

    beforeEach(() => {
      matchStatus = "Live";
      serverIdWriteAffectedRows = 1;

      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches_by_pk?.match_maps) {
          return {
            matches_by_pk: {
              region: "USE",
              password: "secret",
              server_id: null,
              source: "5stack",
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
          return { game_server_nodes: [{ id: "node-1" }] };
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
