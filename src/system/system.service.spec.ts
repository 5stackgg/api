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
  it.each(["api", "web", "hasura", "panel", "redis", "timescaledb"])(
    "reserves %s",
    (name) => {
      expect(SystemService.isReservedDeployment(name)).toBe(true);
    },
  );

  it.each(["inventory-frontend", "inventory-backend", "example-plugin"])(
    "allows %s",
    (name) => {
      expect(SystemService.isReservedDeployment(name)).toBe(false);
    },
  );
});
