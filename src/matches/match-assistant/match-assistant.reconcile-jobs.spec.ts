const listNamespacedJob = jest.fn();
const readNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const listNamespacedPod = jest.fn();
const deleteNamespacedPod = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    listNamespacedJob = listNamespacedJob;
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
  Exec: class Exec {},
}));

import { MatchAssistantService } from "./match-assistant.service";

describe("MatchAssistantService — reconciling on-demand server Jobs", () => {
  const NOW = Date.parse("2026-09-16T12:00:00Z");
  const MINUTE = 60 * 1000;
  const MATCH_ID = "0b6f3c9e-4a57-4d2f-9f0e-3c2b1a0d9e8f";
  const JOB_NAME = `m-${MATCH_ID}`;

  let service: MatchAssistantService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let store: Map<string, unknown>;
  let cache: {
    get: jest.Mock;
    put: jest.Mock;
    forget: jest.Mock;
    lock: jest.Mock;
  };
  let logger: {
    warn: jest.Mock;
    log: jest.Mock;
    error: jest.Mock;
    verbose: jest.Mock;
  };
  let now: number;
  let matches: Array<Record<string, unknown>>;
  let reservedServers: Array<{ id: string; reserved_by_match_id: string }>;

  const job = (overrides: Record<string, any> = {}) => ({
    metadata: {
      name: JOB_NAME,
      uid: "uid-1",
      creationTimestamp: new Date(NOW - 60 * MINUTE),
      ...(overrides.metadata ?? {}),
    },
    status: { active: 1, ...(overrides.status ?? {}) },
  });

  const match = (overrides: Record<string, unknown> = {}) => ({
    id: MATCH_ID,
    status: "Live",
    ended_at: null as string | null,
    cancels_at: null as string | null,
    server_id: "server-1",
    options: { tv_delay: 120 },
    ...overrides,
  });

  const deletedJobs = () =>
    deleteNamespacedJob.mock.calls.map(([request]) => request.name);

  beforeEach(() => {
    for (const fn of [
      listNamespacedJob,
      readNamespacedJob,
      deleteNamespacedJob,
      listNamespacedPod,
      deleteNamespacedPod,
    ]) {
      fn.mockReset();
    }

    now = NOW;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    listNamespacedJob.mockResolvedValue({ items: [job()] });
    readNamespacedJob.mockRejectedValue({ code: 404 });
    deleteNamespacedJob.mockResolvedValue({});
    listNamespacedPod.mockResolvedValue({ items: [] });
    deleteNamespacedPod.mockResolvedValue({});

    matches = [];
    reservedServers = [];

    hasura = {
      query: jest.fn(async (request: any) => {
        if (request.matches) {
          return { matches };
        }
        if (request.servers) {
          return { servers: reservedServers };
        }
        return {};
      }),
      mutation: jest.fn(async () => ({})),
    };

    store = new Map();
    cache = {
      get: jest.fn(async (key: string) => store.get(key)),
      put: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
        return true;
      }),
      forget: jest.fn(async (...keys: Array<string>) => {
        keys.forEach((key) => store.delete(key));
        return true;
      }),
      lock: jest.fn(),
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
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn() } as any,
      { add: jest.fn(), getDelayed: jest.fn() } as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("deletes a running Job whose match row is gone", async () => {
    await service.reconcileOnDemandServerJobs();

    expect(deletedJobs()).toEqual([JOB_NAME]);
  });

  it("deletes a labelled Job whose match row is gone", async () => {
    listNamespacedJob.mockResolvedValue({
      items: [
        job({
          metadata: {
            labels: {
              app: "game-server",
              role: "match",
              "match-id": MATCH_ID,
            },
          },
        }),
      ],
    });

    await service.reconcileOnDemandServerJobs();

    expect(deletedJobs()).toEqual([JOB_NAME]);
  });

  it("keeps a Live match's Job while it holds its on-demand server", async () => {
    matches = [match()];
    reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];

    await service.reconcileOnDemandServerJobs();
    now += 60 * MINUTE;
    await service.reconcileOnDemandServerJobs();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
  });

  // The reservation, the Job and the server_id write are separate statements a sweep can land between.
  it("keeps a Job younger than the create grace", async () => {
    listNamespacedJob.mockResolvedValue({
      items: [job({ metadata: { creationTimestamp: new Date(NOW - MINUTE) } })],
    });

    await service.reconcileOnDemandServerJobs();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("ignores Jobs that already completed or failed", async () => {
    listNamespacedJob.mockResolvedValue({
      items: [
        job({
          status: {
            active: 0,
            conditions: [{ type: "Complete", status: "True" }],
          },
        }),
        job({
          metadata: {
            name: "m-1c0e2d3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
          },
          status: {
            active: 0,
            conditions: [{ type: "Failed", status: "True" }],
          },
        }),
      ],
    });

    await service.reconcileOnDemandServerJobs();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("ignores Jobs that are not match servers", async () => {
    listNamespacedJob.mockResolvedValue({
      items: [
        job({
          metadata: {
            name: `gs-live-${MATCH_ID}`,
            labels: {
              app: "game-streamer",
              role: "live",
              "match-id": MATCH_ID,
            },
          },
        }),
        job({ metadata: { name: "gs-demo-0b6f3c9e4a57" } }),
        job({ metadata: { name: "update-cs-server-node-1" } }),
        job({ metadata: { name: "validate-gamedata-12345-public" } }),
        job({ metadata: { name: "m-notauuid" } }),
      ],
    });

    await service.reconcileOnDemandServerJobs();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("lists only labelled Jobs once no unlabelled match server Job is left", async () => {
    const labelled = job({
      metadata: {
        labels: { app: "game-server", role: "match", "match-id": MATCH_ID },
      },
    });
    matches = [match()];
    reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];

    await service.reconcileOnDemandServerJobs();
    await service.reconcileOnDemandServerJobs();

    listNamespacedJob.mockResolvedValue({ items: [labelled] });
    await service.reconcileOnDemandServerJobs();
    await service.reconcileOnDemandServerJobs();

    expect(
      listNamespacedJob.mock.calls.map(([request]) => request.labelSelector),
    ).toEqual([undefined, undefined, undefined, "app=game-server,role=match"]);
  });

  it("clears the orphan timers of every match holding its server in one call", async () => {
    const other = "1c0e2d3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f";
    listNamespacedJob.mockResolvedValue({
      items: [job(), job({ metadata: { name: `m-${other}`, uid: "uid-2" } })],
    });
    matches = [match(), match({ id: other, server_id: "server-2" })];
    reservedServers = [
      { id: "server-1", reserved_by_match_id: MATCH_ID },
      { id: "server-2", reserved_by_match_id: other },
    ];

    await service.reconcileOnDemandServerJobs();

    expect(cache.forget.mock.calls).toEqual([
      [
        "match-server-job:orphaned-since:uid-1",
        "match-server-job:orphaned-since:uid-2",
      ],
    ]);
  });

  it("deletes nothing when the Jobs cannot be listed", async () => {
    listNamespacedJob.mockRejectedValue(new Error("forbidden"));

    await expect(
      service.reconcileOnDemandServerJobs(),
    ).resolves.toBeUndefined();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("deletes a Job only while it is still the one it listed", async () => {
    await service.reconcileOnDemandServerJobs();

    expect(deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: JOB_NAME,
        body: expect.objectContaining({ preconditions: { uid: "uid-1" } }),
      }),
    );
  });

  it("leaves a Job replaced after it was listed, and the rows its match holds", async () => {
    matches = [
      match({
        status: "Canceled",
        server_id: null,
        cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
      }),
    ];
    reservedServers = [{ id: "server-2", reserved_by_match_id: MATCH_ID }];
    deleteNamespacedJob.mockRejectedValue({ code: 409 });

    await service.reconcileOnDemandServerJobs();

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // Shares the one-worker scheduled-matches queue, and never reuses the name it removes.
  it("does not wait for a removed Job to disappear", async () => {
    await service.reconcileOnDemandServerJobs();

    expect(deletedJobs()).toEqual([JOB_NAME]);
    expect(readNamespacedJob).not.toHaveBeenCalled();
  });

  it("treats a Job that is already gone as deleted", async () => {
    deleteNamespacedJob.mockRejectedValue({ code: 404 });

    await expect(
      service.reconcileOnDemandServerJobs(),
    ).resolves.toBeUndefined();

    expect(deletedJobs()).toEqual([JOB_NAME]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe("a match that has ended", () => {
    it("deletes a Canceled match's Job once the grace has passed", async () => {
      matches = [
        match({
          status: "Canceled",
          server_id: null,
          cancels_at: new Date(NOW - MINUTE).toISOString(),
        }),
      ];

      await service.reconcileOnDemandServerJobs();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();

      now += 15 * MINUTE;
      await service.reconcileOnDemandServerJobs();
      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    it("waits out tv_delay before deleting a Finished match's Job", async () => {
      matches = [
        match({
          status: "Finished",
          server_id: null,
          ended_at: new Date(NOW - 11 * MINUTE).toISOString(),
          options: { tv_delay: 5 * 60 },
        }),
      ];

      await service.reconcileOnDemandServerJobs();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();

      now += 5 * MINUTE;
      await service.reconcileOnDemandServerJobs();
      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    it("counts the grace from when it first saw a match with no end time", async () => {
      matches = [match({ status: "Surrendered", server_id: null })];

      await service.reconcileOnDemandServerJobs();
      now += 5 * MINUTE;
      await service.reconcileOnDemandServerJobs();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();

      now += 10 * MINUTE;
      await service.reconcileOnDemandServerJobs();
      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    // tau_matches only frees the server_id it can see.
    it("releases the on-demand server the match still held", async () => {
      matches = [
        match({
          status: "Canceled",
          server_id: null,
          cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
        }),
      ];
      reservedServers = [{ id: "server-2", reserved_by_match_id: MATCH_ID }];

      await service.reconcileOnDemandServerJobs();

      expect(deletedJobs()).toEqual([JOB_NAME]);
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_servers: expect.objectContaining({
            __args: expect.objectContaining({
              where: {
                reserved_by_match_id: { _eq: MATCH_ID },
                id: { _eq: "server-2" },
                _or: [
                  {
                    current_match: {
                      status: {
                        _in: expect.arrayContaining(["Canceled", "Finished"]),
                      },
                    },
                  },
                  { _not: { matches: { id: { _eq: MATCH_ID } } } },
                ],
              },
            }),
          }),
        }),
      );
    });
  });

  it("deletes a live match's Job once the match no longer holds its server", async () => {
    matches = [match({ status: "Live", server_id: null })];

    await service.reconcileOnDemandServerJobs();
    expect(deleteNamespacedJob).not.toHaveBeenCalled();

    now += 10 * MINUTE;
    await service.reconcileOnDemandServerJobs();
    expect(deletedJobs()).toEqual([JOB_NAME]);
  });

  it("forgets a match that went back to holding its server", async () => {
    matches = [match({ status: "Live", server_id: null })];
    await service.reconcileOnDemandServerJobs();

    matches = [match()];
    reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];
    now += 10 * MINUTE;
    await service.reconcileOnDemandServerJobs();

    matches = [match({ status: "Live", server_id: null })];
    reservedServers = [];
    now += MINUTE;
    await service.reconcileOnDemandServerJobs();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
  });
});
