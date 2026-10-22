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

describe("SystemService api and hasura", () => {
  const repo = "ghcr.io/5stackgg/api";
  const old = "sha256:0ld";
  const latest = "sha256:1a7";
  const newer = "sha256:2e3";
  const originalDev = process.env.DEV;

  let system: SystemService;
  let restart: jest.SpyInstance;
  let pods: Array<{ app: string; imageID: string }>;

  beforeEach(() => {
    delete process.env.DEV;
    pods = [
      { app: "api", imageID: `${repo}@${latest}` },
      { app: "hasura", imageID: `${repo}@${old}` },
    ];

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
            status: { conditions: [{ type: "Ready", status: "True" }] },
          },
        ],
      })),
      listNamespacedPod: jest.fn(async () => ({
        items: pods.map(({ app, imageID }, index) => ({
          metadata: { name: `${app}-${index}`, labels: { app } },
          spec: {
            nodeName: "node-1",
            [app === "hasura" ? "initContainers" : "containers"]: [
              { image: `${repo}:latest` },
            ],
          },
          status: {
            [app === "hasura" ? "initContainerStatuses" : "containerStatuses"]:
              [{ imageID }],
          },
        })),
      })),
    };

    restart = jest.spyOn(system, "restartDeployment").mockResolvedValue();
    jest.spyOn(system as any, "getPluginServices").mockResolvedValue([]);
    jest.spyOn(system, "getLatestDigest").mockResolvedValue(latest);
  });

  afterEach(() => {
    if (originalDev === undefined) {
      delete process.env.DEV;
    } else {
      process.env.DEV = originalDev;
    }
  });

  describe("syncApiAndHasura", () => {
    // The api container restarted on its own and re-pulled :latest, but the
    // hasura pod -- whose init container migrates -- was never replaced.
    it("restarts both when the api pulled a build hasura never migrated", async () => {
      await system.syncApiAndHasura();

      expect(restart.mock.calls).toEqual([["hasura"], ["api"]]);
    });

    it("restarts both when hasura pulled a build the api is not running", async () => {
      pods[0].imageID = `${repo}@${old}`;
      pods[1].imageID = `${repo}@${latest}`;

      await system.syncApiAndHasura();

      expect(restart.mock.calls).toEqual([["hasura"], ["api"]]);
    });

    it("leaves both alone on the same build", async () => {
      pods[1].imageID = `${repo}@${latest}`;

      await system.syncApiAndHasura();

      expect(restart).not.toHaveBeenCalled();
    });

    it("leaves a hasura rollout alone while its new pod migrates", async () => {
      pods.push({ app: "hasura", imageID: `${repo}@${latest}` });

      await system.syncApiAndHasura();

      expect(restart).not.toHaveBeenCalled();
    });

    // The registry digest is cached, so the new hasura pod can pull a build
    // the cache has not seen yet. Each restart deleted the pod that was
    // migrating, and that deletion queued the next check five seconds later.
    it("leaves a hasura pod that pulled past the cached registry digest to migrate", async () => {
      pods.push({ app: "hasura", imageID: `${repo}@${newer}` });

      await system.syncApiAndHasura();

      expect(restart).not.toHaveBeenCalled();
    });

    it("leaves a hasura rollout alone while its new pod pulls", async () => {
      pods.push({ app: "hasura", imageID: "" });

      await system.syncApiAndHasura();

      expect(restart).not.toHaveBeenCalled();
    });

    it("leaves an api rollout alone", async () => {
      pods.push({ app: "api", imageID: `${repo}@${old}` });

      await system.syncApiAndHasura();

      expect(restart).not.toHaveBeenCalled();
    });
  });

  describe("getOutdated", () => {
    it("reports hasura with the api when only the api is behind", async () => {
      pods[0].imageID = `${repo}@${old}`;
      pods[1].imageID = `${repo}@${latest}`;

      expect(await system.getOutdated()).toEqual([
        expect.objectContaining({ service: "api", currentVersion: old }),
        expect.objectContaining({ service: "hasura", currentVersion: latest }),
      ]);
    });

    it("reports the api with hasura when only hasura is behind", async () => {
      expect(await system.getOutdated()).toEqual([
        expect.objectContaining({ service: "api", currentVersion: latest }),
        expect.objectContaining({ service: "hasura", currentVersion: old }),
      ]);
    });

    it("reports neither once both run the latest build", async () => {
      pods[1].imageID = `${repo}@${latest}`;

      expect(await system.getOutdated()).toEqual([]);
    });
  });
});
