jest.mock("@kubernetes/client-node", () => ({
  CoreV1Api: class CoreV1Api {},
  AppsV1Api: class AppsV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient() {
      return {};
    }
  },
  setHeaderOptions: jest.fn(),
  PatchStrategy: {},
}));

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
