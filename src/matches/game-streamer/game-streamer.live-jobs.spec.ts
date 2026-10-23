const createNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const listNamespacedJob = jest.fn();
const createNamespacedService = jest.fn();
const deleteNamespacedService = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    createNamespacedJob = createNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
    listNamespacedJob = listNamespacedJob;
    readNamespacedJob = jest.fn().mockRejectedValue({ code: 404 });
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = jest.fn().mockResolvedValue({ items: [] });
    createNamespacedService = createNamespacedService;
    deleteNamespacedService = deleteNamespacedService;
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import {
  GameStreamerService,
  NoSteamAccountAvailableError,
} from "./game-streamer.service";

// After a switch the pod keeps the name it was started under, so a stream's
// row can name a job that says another match.
describe("GameStreamerService — live stream jobs", () => {
  let service: GameStreamerService;
  let streams: Map<string, string | null>;
  let claims: Map<string, string>;
  let poolSize: number;
  let gpuFree: boolean;

  const config = {
    get: (key: string) => {
      if (key === "gameServers") {
        return { namespace: "test", gameStreamerImage: "5stack/game-streamer" };
      }
      if (key === "app") {
        return { encSecret: "test-secret", gameStreamDomain: "https://tv" };
      }
      return {} as any;
    },
  };

  const launchedJob = (call = 0) =>
    createNamespacedJob.mock.calls[call][0].body.metadata.name as string;
  const deletedJobs = () =>
    deleteNamespacedJob.mock.calls.map(([arg]: [any]) => arg.name);
  const deletedServices = () =>
    deleteNamespacedService.mock.calls.map(([arg]: [any]) => arg.name);

  beforeEach(() => {
    createNamespacedJob.mockReset().mockResolvedValue({});
    deleteNamespacedJob.mockReset().mockRejectedValue({ code: 404 });
    listNamespacedJob.mockReset().mockResolvedValue({ items: [] });
    createNamespacedService.mockReset().mockResolvedValue({});
    deleteNamespacedService.mockReset().mockRejectedValue({ code: 404 });
    streams = new Map();
    claims = new Map();
    poolSize = 2;
    gpuFree = true;

    // Only what goes through the transaction's client is rolled back.
    let undo: Array<() => void> = [];
    const tracked = <K, V>(map: Map<K, V>, key: K, value?: V) => {
      const had = map.has(key);
      const before = map.get(key) as V;
      undo.push(() => (had ? map.set(key, before) : map.delete(key)));
      if (value === undefined) {
        map.delete(key);
      } else {
        map.set(key, value);
      }
    };

    const client = {
      query: jest.fn(async (sql: string, params: Array<any> = []) => {
        if (sql.includes("DELETE FROM match_streams")) {
          if (!streams.has(params[0])) {
            return { rows: [] };
          }
          const name = streams.get(params[0]);
          tracked(streams, params[0]);
          return { rows: [{ k8s_service_name: name }] };
        }
        if (sql.includes("claim_free_gpu_node")) {
          if (!gpuFree) {
            return { rows: [] };
          }
          tracked(streams, params[0], params[5]);
          return { rows: [{ game_server_node_id: "node-A" }] };
        }
        if (sql.includes("count(*)")) {
          return { rows: [{ n: 1 }] };
        }
        if (sql.includes("INSERT INTO match_streams")) {
          tracked(streams, params[0], params[5]);
          return { rows: [] };
        }
        if (sql.includes("DELETE FROM steam_account_claims")) {
          tracked(claims, params[0]);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    const steamAccounts = {
      claim: jest.fn(
        async ({ jobName }: { jobName: string }, viaClient?: unknown) => {
          if (claims.has(jobName)) {
            tracked(claims, jobName);
          }
          if (claims.size >= poolSize) {
            throw new NoSteamAccountAvailableError();
          }
          if (viaClient) {
            tracked(claims, jobName, "new-account");
          } else {
            claims.set(jobName, "new-account");
          }
          return { id: "sa-new", username: "new-account", password: "pw" };
        },
      ),
      release: jest.fn(async (jobName: string, viaClient?: typeof client) => {
        if (viaClient) {
          await viaClient.query(
            "DELETE FROM steam_account_claims WHERE k8s_job_name = $1",
            [jobName],
          );
          return;
        }
        claims.delete(jobName);
      }),
    };

    const hasura = {
      query: jest.fn(async (selector: Record<string, any>) => {
        if (selector.matches_by_pk) {
          return {
            matches_by_pk: {
              id: selector.matches_by_pk.__args.id,
              status: "Live",
              password: "pw",
              server: { connected: true, enabled: true },
            },
          };
        }
        if (selector.match_streams?.__args.where.k8s_service_name) {
          const names: Array<string> =
            selector.match_streams.__args.where.k8s_service_name._in;
          return {
            match_streams: [...streams.values()]
              .filter((name) => names.includes(name as string))
              .map((name) => ({ k8s_service_name: name })),
          };
        }
        if (selector.match_streams) {
          const matchId = selector.match_streams.__args.where.match_id._eq;
          return {
            match_streams: streams.has(matchId)
              ? [{ k8s_service_name: streams.get(matchId) }]
              : [],
          };
        }
        return {};
      }),
      mutation: jest.fn(async (selector: Record<string, any>) => {
        if (selector.delete_match_streams) {
          const where = selector.delete_match_streams.__args.where;
          const name = where.k8s_service_name?._eq;
          if (!name || streams.get(where.match_id._eq) === name) {
            streams.delete(where.match_id._eq);
          }
        }
        return {};
      }),
    };

    service = new GameStreamerService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      config as any,
      hasura as any,
      {
        query: jest.fn().mockResolvedValue([]),
        transaction: jest.fn(async (fn: (c: unknown) => unknown) => {
          undo = [];
          try {
            return await fn(client);
          } catch (error) {
            for (const step of undo.reverse()) {
              step();
            }
            throw error;
          }
        }),
      } as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      {} as any,
      steamAccounts as any,
      { resolveDefault: jest.fn().mockResolvedValue(null) } as any,
    );

    for (const method of [
      "resolveHudEnv",
      "buildNodeCs2OptionsEnv",
      "buildConnectEnv",
    ]) {
      jest.spyOn(service as any, method).mockResolvedValue([]);
    }
    for (const method of [
      "resolveLiveVideoCodec",
      "resolveClipVideoCodec",
      "resolveClipBakeBranding",
    ]) {
      jest.spyOn(service as any, method).mockResolvedValue("h264");
    }
    jest.spyOn(service as any, "readUsePlaycast").mockResolvedValue(false);
  });

  it("restarting a switched stream takes down the pod it was switched on", async () => {
    streams.set("match-b", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-b");

    await expect(service.startLive("match-b", "live")).resolves.toEqual({
      status: "booting",
    });

    expect(deletedJobs()).toContain("gs-live-match-a");
    expect(deletedServices()).toContain("gs-live-match-a");
    expect(claims.has("gs-live-match-a")).toBe(false);
    expect(launchedJob()).not.toBe("gs-live-match-a");
    expect(claims.get(launchedJob())).toBe("new-account");
    expect(streams.get("match-b")).toBe(launchedJob());
  });

  it("starting the match a stream was switched away from leaves that stream alone", async () => {
    streams.set("match-b", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-b");

    await service.startLive("match-a", "live");

    expect(deletedJobs()).not.toContain("gs-live-match-a");
    expect(claims.get("gs-live-match-a")).toBe("streaming-b");
    expect(launchedJob()).not.toBe("gs-live-match-a");
    expect(streams.get("match-b")).toBe("gs-live-match-a");
  });

  it("points a stream's Service at its own pod, not at every pod started for the match", async () => {
    await service.startLive("match-a", "live");

    const service_ = createNamespacedService.mock.calls[0][0].body;
    expect(service_.metadata.name).toBe(launchedJob());
    expect(service_.spec.selector).toEqual({
      app: "game-streamer",
      role: "live",
      "job-name": launchedJob(),
    });
  });

  it("stopping a match with no stream leaves the stream switched away from it alone", async () => {
    streams.set("match-b", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-b");
    listNamespacedJob.mockResolvedValue({
      items: [
        {
          metadata: { name: "gs-live-match-a", creationTimestamp: new Date() },
        },
      ],
    });

    await service.stopLive("match-a");

    expect(deletedJobs()).toEqual([]);
    expect(deleteNamespacedService).not.toHaveBeenCalled();
    expect(claims.get("gs-live-match-a")).toBe("streaming-b");
  });

  it("deleting a streaming match removes its pod at once", async () => {
    listNamespacedJob.mockResolvedValue({
      items: [
        {
          metadata: {
            name: "gs-live-match-a-aaaaaa",
            creationTimestamp: new Date(),
          },
        },
      ],
    });

    await service.stopLive("match-a");

    expect(deletedJobs()).toEqual(["gs-live-match-a-aaaaaa"]);
    expect(deletedServices()).toEqual(["gs-live-match-a-aaaaaa"]);
  });

  it("restarts a stream on a pool of one account", async () => {
    poolSize = 1;
    streams.set("match-a", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-a");

    await expect(service.startLive("match-a", "live")).resolves.toEqual({
      status: "booting",
    });

    expect(deletedJobs()).toContain("gs-live-match-a");
    expect(claims.get(launchedJob())).toBe("new-account");
  });

  it("keeps the running stream and its account when a restart cannot claim one", async () => {
    poolSize = 0;
    streams.set("match-a", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-a");

    await expect(service.startLive("match-a", "live")).rejects.toBeInstanceOf(
      NoSteamAccountAvailableError,
    );

    expect(deletedJobs()).toEqual([]);
    expect(claims.get("gs-live-match-a")).toBe("streaming-a");
    expect(streams.get("match-a")).toBe("gs-live-match-a");
  });

  it("a restart that waits for a GPU still takes down the old pod once it gets one", async () => {
    streams.set("match-a", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-a");
    gpuFree = false;

    await expect(service.startLive("match-a", "live")).resolves.toEqual({
      status: "pending",
    });

    expect(deletedJobs()).toEqual([]);
    expect(claims.get("gs-live-match-a")).toBe("streaming-a");
    expect(streams.get("match-a")).toBe("gs-live-match-a");

    gpuFree = true;
    await expect(service.startLive("match-a", "live")).resolves.toEqual({
      status: "booting",
    });

    expect(deletedJobs()).toContain("gs-live-match-a");
    expect(claims.has("gs-live-match-a")).toBe(false);
    expect(streams.get("match-a")).toBe(launchedJob());
  });

  it("a restart that cannot connect leaves the running stream alone", async () => {
    streams.set("match-a", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-a");
    jest
      .spyOn(service as any, "buildConnectEnv")
      .mockRejectedValue(new Error("tv mode requires a tv port"));

    await expect(service.startLive("match-a", "tv")).rejects.toThrow(
      "tv mode requires a tv port",
    );

    expect(deletedJobs()).toEqual([]);
    expect(claims.get("gs-live-match-a")).toBe("streaming-a");
    expect(streams.get("match-a")).toBe("gs-live-match-a");
  });

  it("a restart that fails after claiming leaves no pod running under a name nothing points at", async () => {
    streams.set("match-a", "gs-live-match-a");
    claims.set("gs-live-match-a", "streaming-a");
    jest
      .spyOn(service as any, "buildNodeCs2OptionsEnv")
      .mockRejectedValue(new Error("node lookup failed"));

    await expect(service.startLive("match-a", "live")).rejects.toThrow(
      "node lookup failed",
    );

    expect(deletedJobs()).toContain("gs-live-match-a");
    expect(streams.has("match-a")).toBe(false);
    expect(claims.size).toBe(0);
  });

  it("a start that fails after another took the stream over leaves the other's row", async () => {
    jest
      .spyOn(service as any, "buildNodeCs2OptionsEnv")
      .mockImplementation(async () => {
        streams.set("match-a", "gs-live-match-a-other");
        throw new Error("node lookup failed");
      });

    await expect(service.startLive("match-a", "live")).rejects.toThrow(
      "node lookup failed",
    );

    expect(streams.get("match-a")).toBe("gs-live-match-a-other");
  });

  it("a start that loses the stream to another while creating its pod removes that pod", async () => {
    createNamespacedJob.mockImplementationOnce(async () => {
      streams.set("match-a", "gs-live-match-a-other");
      return {};
    });

    await service.startLive("match-a", "live");

    expect(deletedJobs()).toContain(launchedJob());
    expect(deletedServices()).toContain(launchedJob());
    expect(streams.get("match-a")).toBe("gs-live-match-a-other");
  });

  it("hands the account back when the pod cannot be created, so a retry can take it", async () => {
    poolSize = 1;
    createNamespacedJob.mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(service.startLive("match-a", "live")).rejects.toThrow(
      "quota exceeded",
    );
    expect(deletedJobs()).toContain(launchedJob(0));
    expect(claims.size).toBe(0);

    await expect(service.startLive("match-a", "live")).resolves.toEqual({
      status: "booting",
    });
    expect(claims.get(launchedJob(1))).toBe("new-account");
  });

  it("reaps a live job no stream row names once it has settled", async () => {
    const job = (name: string, ageMs: number) => ({
      metadata: {
        name,
        creationTimestamp: new Date(Date.now() - ageMs),
      },
    });
    listNamespacedJob.mockResolvedValue({
      items: [
        job("gs-live-match-a-aaaaaa", 600_000),
        job("gs-live-match-b-bbbbbb", 600_000),
        job("gs-live-match-c-cccccc", 5_000),
      ],
    });
    streams.set("match-z", "gs-live-match-a-aaaaaa");
    jest
      .spyOn(service as any, "reapOrphanDemoK8sResources")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "reconcileSteamClaims")
      .mockResolvedValue(undefined);

    await service.reapOrphanDemoResources();

    expect(listNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ labelSelector: "app=game-streamer,role=live" }),
    );
    expect(deletedJobs()).toEqual(["gs-live-match-b-bbbbbb"]);
    expect(deletedServices()).toEqual(["gs-live-match-b-bbbbbb"]);
  });
});
