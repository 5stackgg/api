import { SystemService } from "./system.service";

describe("SystemService.parseImageRef", () => {
  // The first-party services this has always had to handle, plus the shapes a
  // third-party plugin can realistically ship. Getting the registry/repository
  // split wrong sends the manifest request to the wrong host and every plugin
  // silently reports "no update available".
  const vectors: Array<{
    image: string;
    registry: string;
    repository: string;
    tag: string;
  }> = [
    {
      image: "ghcr.io/5stackgg/api:latest",
      registry: "ghcr.io",
      repository: "5stackgg/api",
      tag: "latest",
    },
    // A plugin published under someone else's org -- the case the old
    // hardcoded `5stackgg` path could not express at all.
    {
      image: "ghcr.io/lukepolo/5stack-inventory-plugin-frontend:latest",
      registry: "ghcr.io",
      repository: "lukepolo/5stack-inventory-plugin-frontend",
      tag: "latest",
    },
    // The deployed tag is the release channel; beta must not collapse to latest.
    {
      image: "ghcr.io/5stackgg/web:beta",
      registry: "ghcr.io",
      repository: "5stackgg/web",
      tag: "beta",
    },
    {
      image: "docker.io/library/nginx:1.27",
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.27",
    },
    // No registry host and no tag: Docker Hub official image, implicit latest.
    {
      image: "nginx",
      registry: "docker.io",
      repository: "library/nginx",
      tag: "latest",
    },
    // Bare namespaced image is Hub too -- "myorg" has no dot, so it is not a host.
    {
      image: "myorg/myimage:v2",
      registry: "docker.io",
      repository: "myorg/myimage",
      tag: "v2",
    },
    // A port in the host means the first segment IS the registry, and the colon
    // in it must not be mistaken for the tag separator.
    {
      image: "registry.local:5000/team/app:dev",
      registry: "registry.local:5000",
      repository: "team/app",
      tag: "dev",
    },
    {
      image: "registry.local:5000/team/app",
      registry: "registry.local:5000",
      repository: "team/app",
      tag: "latest",
    },
  ];

  for (const { image, ...expected } of vectors) {
    it(`parses ${image}`, () => {
      expect(SystemService.parseImageRef(image)).toEqual(expected);
    });
  }

  // A digest-pinned image already names exact bytes, so there is nothing to
  // poll -- returning a ref would make us compare a digest against itself.
  it.each(["ghcr.io/5stackgg/api@sha256:abc123", "", null, undefined])(
    "returns null for %p",
    (image) => {
      expect(SystemService.parseImageRef(image as string)).toBeNull();
    },
  );
});

describe("SystemService.isReservedDeployment", () => {
  // Plugin manifests are third-party input. If these names were claimable, a
  // plugin could get the panel to restart the panel.
  it.each([
    "api",
    "web",
    "hasura",
    "panel",
    "redis",
    "timescaledb",
    "rustfs",
    // minio outlives its own deployment as a Service alias.
    "minio",
  ])("reserves %s", (name) => {
    expect(SystemService.isReservedDeployment(name)).toBe(true);
  });

  it.each(["inventory-frontend", "inventory-backend", "example-plugin"])(
    "allows %s",
    (name) => {
      expect(SystemService.isReservedDeployment(name)).toBe(false);
    },
  );
});

describe("SystemService.setVersions", () => {
  let hasura: { mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let system: SystemService;

  const outdated = {
    service: "api",
    pod: "api-7d9f",
    currentVersion: "sha256:old",
    newVersion: "sha256:new",
  };

  const run = async (stored: string | undefined, current: unknown[]) => {
    postgres.query.mockResolvedValue(
      stored === undefined ? [] : [{ value: stored }],
    );
    jest.spyOn(system, "getPanelVersion").mockResolvedValue("abc123");
    jest
      .spyOn(system as any, "getLatestPanelVersion")
      .mockResolvedValue("abc123");
    jest.spyOn(system, "getOutdated").mockResolvedValue(current as any);

    await system.setVersions();
  };

  const written = () =>
    hasura.mutation.mock.calls[0][0].insert_settings_one.__args.object;

  beforeEach(() => {
    hasura = { mutation: jest.fn().mockResolvedValue({}) };
    postgres = { query: jest.fn() };
    system = new SystemService(
      {} as any,
      hasura as any,
      {} as any,
      { warn: jest.fn(), log: jest.fn() } as any,
      postgres as any,
    );
  });

  it("does not write when there is still nothing to update", async () => {
    await run("[]", []);

    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("does not write an update it already reported", async () => {
    await run(JSON.stringify([outdated]), [outdated]);

    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("writes when an update appears", async () => {
    await run("[]", [outdated]);

    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({
      name: "updates",
      value: JSON.stringify([outdated]),
    });
  });

  it("writes when a reported update is applied", async () => {
    await run(JSON.stringify([outdated]), []);

    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({ name: "updates", value: "[]" });
  });

  it("writes the first report on a fresh install", async () => {
    await run(undefined, []);

    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({ name: "updates", value: "[]" });
  });
});

describe("SystemService.getOutdated", () => {
  let system: SystemService;
  let images: Array<{ names: string[]; sizeBytes: number }>;

  const repo = "ghcr.io/5stackgg/game-server-node-connector";
  const old = "sha256:d2dc";
  const latest = "sha256:f501";

  beforeEach(() => {
    images = [];
    system = new SystemService(
      {} as any,
      {} as any,
      {} as any,
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
    );

    (system as any).apiClient = {
      listNode: jest.fn(async () => ({
        items: [
          {
            metadata: { name: "node-1" },
            status: {
              conditions: [{ type: "Ready", status: "True" }],
              images,
            },
          },
        ],
      })),
      listNamespacedPod: jest.fn(async () => ({
        items: [
          {
            metadata: {
              name: "game-server-node-connector-x7k2p",
              labels: { app: "game-server-node-connector" },
            },
            spec: {
              nodeName: "node-1",
              containers: [{ image: `${repo}:latest` }],
            },
            status: {
              containerStatuses: [{ imageID: `${repo}@${old}` }],
            },
          },
        ],
      })),
    };

    jest.spyOn(system as any, "getPluginServices").mockResolvedValue([]);
    jest.spyOn(system, "getLatestDigest").mockResolvedValue(latest);
  });

  // A rebuild that changes nothing in the image moves :latest to a new digest,
  // and the re-pull files it under the image the node already has. containerd
  // keeps reporting the first digest in sorted order, so a restart can never
  // make the pod report the new one.
  it("counts any digest the node knows the running image by", async () => {
    images.push({
      names: [`${repo}@${old}`, `${repo}@${latest}`, `${repo}:latest`],
      sizeBytes: 1,
    });

    expect(await system.getOutdated()).toEqual([]);
  });

  it("reports an update the node has not pulled", async () => {
    images.push({
      names: [`${repo}@${old}`, `${repo}:latest`],
      sizeBytes: 1,
    });

    expect(await system.getOutdated()).toEqual([
      {
        service: "game-server-node-connector",
        plugin: undefined,
        pod: "game-server-node-connector-x7k2p",
        currentVersion: old,
        newVersion: latest,
      },
    ]);
  });

  it("falls back to the pod's digest when the node does not list the image", async () => {
    expect(await system.getOutdated()).toEqual([
      expect.objectContaining({ currentVersion: old, newVersion: latest }),
    ]);
  });
});

describe("SystemService.syncImportedHighlightsSupport", () => {
  let hasura: { mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let system: SystemService;

  const run = async (settings: Record<string, string>) => {
    postgres.query.mockImplementation(async (_sql: string, [name]: [string]) =>
      name in settings ? [{ value: settings[name] }] : [],
    );

    await system.syncImportedHighlightsSupport();

    return hasura.mutation.mock.calls[0][0].insert_settings_one.__args.object;
  };

  beforeEach(() => {
    hasura = { mutation: jest.fn().mockResolvedValue({}) };
    postgres = { query: jest.fn() };
    system = new SystemService(
      {} as any,
      hasura as any,
      {} as any,
      { warn: jest.fn(), log: jest.fn() } as any,
      postgres as any,
    );
  });

  it("reports support when both toggles are on", async () => {
    expect(
      await run({
        auto_generate_match_clips: "true",
        auto_generate_match_clips_imported: "true",
      }),
    ).toEqual({ name: "public.supports_imported_highlights", value: "true" });
  });

  it("reads 1 as on, the way the clip gate does", async () => {
    expect(
      await run({
        auto_generate_match_clips: "1",
        auto_generate_match_clips_imported: "1",
      }),
    ).toEqual({ name: "public.supports_imported_highlights", value: "true" });
  });

  it.each([
    [
      "imported matches are left out",
      {
        auto_generate_match_clips: "true",
        auto_generate_match_clips_imported: "false",
      },
    ],
    [
      "auto highlights are off altogether",
      {
        auto_generate_match_clips: "false",
        auto_generate_match_clips_imported: "true",
      },
    ],
    ["neither toggle has ever been set", {}],
  ])("reports no support when %s", async (_case, settings) => {
    expect(await run(settings as Record<string, string>)).toEqual({
      name: "public.supports_imported_highlights",
      value: "false",
    });
  });
});

describe("SystemService.syncTwitchSupport", () => {
  let hasura: { mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let system: SystemService;

  const run = async (settings: Record<string, string>) => {
    postgres.query.mockImplementation(async (_sql: string, [name]: [string]) =>
      name in settings ? [{ value: settings[name] }] : [],
    );

    await system.syncTwitchSupport();

    return hasura.mutation.mock.calls[0][0].insert_settings_one.__args.object;
  };

  beforeEach(() => {
    hasura = { mutation: jest.fn().mockResolvedValue({}) };
    postgres = { query: jest.fn() };
    system = new SystemService(
      {} as any,
      hasura as any,
      {} as any,
      { warn: jest.fn(), log: jest.fn() } as any,
      postgres as any,
    );
  });

  it("reports support once both keys are set", async () => {
    expect(
      await run({
        twitch_client_id: "client-id",
        twitch_client_secret: "client-secret",
      }),
    ).toEqual({ name: "public.supports_twitch", value: "true" });
  });

  it.each([
    ["the secret is missing", { twitch_client_id: "client-id" }],
    ["the client id is missing", { twitch_client_secret: "client-secret" }],
    [
      "a key was cleared",
      { twitch_client_id: "client-id", twitch_client_secret: " " },
    ],
    ["neither key has ever been set", {}],
  ])("reports no support when %s", async (_case, settings) => {
    expect(await run(settings as Record<string, string>)).toEqual({
      name: "public.supports_twitch",
      value: "false",
    });
  });
});

describe("SystemService.syncHasura", () => {
  const repo = "ghcr.io/5stackgg/api";
  const old = "sha256:0ld";
  const latest = "sha256:1a7";
  const originalPodName = process.env.POD_NAME;
  const originalDev = process.env.DEV;

  let hasura: { needsSetup: jest.Mock };
  let cache: { acquireLock: jest.Mock; releaseLock: jest.Mock };
  let system: SystemService;
  let restart: jest.SpyInstance;
  let hasuraInit: string;
  let hasuraStarted: Date | undefined;
  let deployment: Record<string, unknown>;

  const apiStarted = new Date("2026-10-21T12:00:00Z");

  const pod = (
    name: string,
    app: string,
    imageID: string,
    startedAt: Date | undefined,
    init = false,
    phase = "Running",
  ) => ({
    metadata: { name, labels: { app } },
    spec: {
      nodeName: "node-1",
      ...(init
        ? {
            initContainers: [{ image: `${repo}:latest` }],
            containers: [{ image: "hasura/graphql-engine:v2.50.3" }],
          }
        : { containers: [{ image: `${repo}:latest` }] }),
    },
    status: init
      ? {
          phase,
          initContainerStatuses: [
            {
              imageID,
              state: startedAt ? { terminated: { startedAt } } : {},
            },
          ],
        }
      : {
          phase,
          containerStatuses: [{ imageID, state: { running: { startedAt } } }],
        },
  });

  let pods: () => unknown[];

  beforeEach(() => {
    delete process.env.DEV;
    process.env.POD_NAME = "api-5c8d";
    hasuraInit = `${repo}@${old}`;
    hasuraStarted = new Date("2026-10-14T09:30:00Z");
    deployment = {
      metadata: { generation: 4 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 4,
        replicas: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    };

    hasura = { needsSetup: jest.fn().mockResolvedValue(true) };
    cache = {
      acquireLock: jest.fn().mockResolvedValue("token"),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    system = new SystemService(
      cache as any,
      hasura as any,
      {} as any,
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
    );

    (system as any).apiClient = {
      listNode: jest.fn(async () => ({
        items: [
          {
            metadata: { name: "node-1" },
            status: {
              conditions: [{ type: "Ready", status: "True" }],
            },
          },
        ],
      })),
      listNamespacedPod: jest.fn(async () => ({ items: pods() })),
    };
    (system as any).appsClient = {
      readNamespacedDeployment: jest.fn(async () => deployment),
    };

    pods = () => [
      pod("api-5c8d", "api", `${repo}@${latest}`, apiStarted),
      pod("hasura-7f6b", "hasura", hasuraInit, hasuraStarted, true),
    ];

    restart = jest.spyOn(system, "restartDeployment").mockResolvedValue();
  });

  afterEach(() => {
    for (const [name, value] of [
      ["POD_NAME", originalPodName],
      ["DEV", originalDev],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  const restarted = () => restart.mock.calls.map(([name]) => name);

  // The api container restarted on its own and re-pulled :latest, but hasura's
  // pod -- whose init container is what migrates -- was never replaced.
  it("restarts hasura when the api runs a build hasura never migrated", async () => {
    await system.syncHasura();

    expect(restarted()).toEqual(["hasura"]);
  });

  // The node dropped the image hasura's init container ran, so its pod reports
  // a bare image id and the update check never lists hasura at all.
  it("restarts hasura when its pod no longer reports a digest", async () => {
    hasuraInit = "sha256:5e1f";

    await system.syncHasura();

    expect(restarted()).toEqual(["hasura"]);
  });

  // The ReplicaSet never deletes a pod kubelet rejected after a reboot, and its
  // init container never started.
  it("ignores a hasura pod that will never run again", async () => {
    const current = pods;
    pods = () => [
      ...current(),
      pod("hasura-2c4e", "hasura", "", undefined, true, "Failed"),
    ];

    await system.syncHasura();

    expect(restarted()).toEqual(["hasura"]);
  });

  it("leaves it to a check that is already running", async () => {
    cache.acquireLock.mockResolvedValue(null);

    await system.syncHasura();

    expect(hasura.needsSetup).not.toHaveBeenCalled();
    expect(restarted()).toEqual([]);
  });

  it("leaves hasura alone when the schema matches this build", async () => {
    hasura.needsSetup.mockResolvedValue(false);

    await system.syncHasura();

    expect(restarted()).toEqual([]);
  });

  // Hasura pulled :latest after this api did, so the schema is ahead of the
  // api. Restarting hasura would only pull that newer build again -- and this
  // is also the state every restart leaves behind, so it never repeats.
  it("leaves hasura alone once it has migrated since this api started", async () => {
    hasuraStarted = new Date("2026-10-21T12:05:00Z");

    await system.syncHasura();

    expect(restarted()).toEqual([]);
  });

  it("does not restart hasura over a build it already ran", async () => {
    hasuraInit = `${repo}@${latest}`;

    await system.syncHasura();

    expect(restarted()).toEqual([]);
  });

  // Restarting mid-rollout would kill an init container part way through a
  // migration, and every api boot during an Update lands in this window.
  it("does not interrupt a hasura rollout that is still going", async () => {
    deployment.status = {
      observedGeneration: 5,
      replicas: 2,
      updatedReplicas: 1,
      availableReplicas: 1,
    };
    deployment.metadata = { generation: 5 };

    await system.syncHasura();

    expect(restarted()).toEqual([]);
  });

  it("never throws when the cluster cannot be read", async () => {
    (system as any).apiClient.listNamespacedPod = jest.fn(async () => {
      throw new Error("forbidden");
    });

    await expect(system.syncHasura()).resolves.toBeUndefined();
    expect(restarted()).toEqual([]);
  });
});
