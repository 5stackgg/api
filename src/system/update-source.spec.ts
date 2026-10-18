import { SystemService } from "./system.service";
import {
  UPDATE_SOURCE_COMPONENTS,
  installedUpdateSource,
  parseUpdateSource,
  sourceImage,
  validImageReference,
} from "./update-source";

const digest = (letter: string) => "sha256:" + letter.repeat(64);
const images = (tag = "testing") =>
  Object.fromEntries(
    UPDATE_SOURCE_COMPONENTS.map((name) => [
      name,
      "ghcr.io/example/" + name + ":" + tag,
    ]),
  );
const custom = () =>
  parseUpdateSource({
    version: 1,
    mode: "custom",
    images: images(),
    panel: null,
  });

describe("update source validation", () => {
  it("requires a complete custom core set rather than falling back to official images", () => {
    expect(() =>
      parseUpdateSource({
        version: 1,
        mode: "custom",
        images: { api: "ghcr.io/example/api:testing" },
      }),
    ).toThrow("every custom");
  });
  it("retains a custom branch and each exact tag or pin", () => {
    const input = {
      version: 1,
      mode: "custom",
      images: { ...images(), api: "ghcr.io/example/api@" + digest("a") },
      panel: { repository: "example/5stack-panel", ref: "release/testing" },
    };
    expect(parseUpdateSource(input)).toEqual(input);
  });
  it.each([
    "https://host/image:tag",
    "name:tag;id",
    "user:pass@registry/image:tag",
    "image@sha256:bad",
    "name:tag\n",
    "UPPER/Repo:tag",
  ])("rejects %p", (value) => {
    expect(validImageReference(value)).toBe(false);
  });
  it.each([
    "registry.local:5000/team/app:testing",
    "ghcr.io/example/app@" + digest("a"),
    "myorg/myimage:v2",
    "nginx",
  ])("accepts %p", (value) => {
    expect(validImageReference(value)).toBe(true);
  });
  it.each(["../main", "beta;id", "-other", "refs//main", "topic.lock"])(
    "rejects unsafe panel ref %p",
    (ref) => {
      expect(() =>
        parseUpdateSource({
          version: 1,
          mode: "custom",
          images: images(),
          panel: { repository: "example/panel", ref },
        }),
      ).toThrow("repository or ref");
    },
  );
  it("uses beta for every official component without a stable fallback", () => {
    const source = parseUpdateSource({
      version: 1,
      mode: "official",
      channel: "beta",
    });
    expect(source.panel).toEqual({
      repository: "5stackgg/5stack-panel",
      ref: "beta",
    });
    for (const name of UPDATE_SOURCE_COMPONENTS)
      expect(sourceImage(source, name, "unused")).toBe(
        "ghcr.io/5stackgg/" + name + ":beta",
      );
    expect(sourceImage(source, "hasura", "unused")).toBe(
      "ghcr.io/5stackgg/api:beta",
    );
    expect(
      sourceImage(source, "game-server-node-connector-nvidia", "unused"),
    ).toBe("ghcr.io/5stackgg/game-server-node-connector:beta");
  });
});

describe("selected-source checks and update actions", () => {
  let system: SystemService;
  let lookup: jest.SpyInstance;
  const pod = (image: string, versions = [digest("a")]) => ({
    service: "api",
    pod: "api-test",
    image,
    version: digest("a"),
    versions,
  });
  beforeEach(() => {
    system = new SystemService(
      {} as any,
      { mutation: jest.fn() } as any,
      {} as any,
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
    );
    jest.spyOn(system as any, "getPluginServices").mockResolvedValue([]);
    jest
      .spyOn(system as any, "desiredServiceImage")
      .mockImplementation(
        async (service) =>
          (await system.getServices()).find((row) => row.service === service)
            ?.image ?? null,
      );
    lookup = jest
      .spyOn(system, "getLatestDigest")
      .mockResolvedValue(digest("b"));
  });
  it("polls only the chosen custom reference and does not restart a different installed source", async () => {
    jest.spyOn(system, "getUpdateSource").mockResolvedValue(custom());
    jest
      .spyOn(system, "getServices")
      .mockResolvedValue([pod("ghcr.io/5stackgg/api:latest")]);
    const restart = jest
      .spyOn(system, "restartService")
      .mockResolvedValue(undefined);
    await system.updateServices();
    expect(lookup).toHaveBeenCalledWith("ghcr.io/example/api:testing");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });
  it("does not treat a missing beta build as a stable update", async () => {
    jest
      .spyOn(system, "getUpdateSource")
      .mockResolvedValue(
        parseUpdateSource({ version: 1, mode: "official", channel: "beta" }),
      );
    jest
      .spyOn(system, "getServices")
      .mockResolvedValue([pod("ghcr.io/5stackgg/api:beta")]);
    lookup.mockResolvedValue(null);
    expect(await system.getOutdated()).toEqual([]);
    expect(lookup.mock.calls).toEqual([["ghcr.io/5stackgg/api:beta"]]);
  });
  it("reports the selected tag and exact target digest", async () => {
    jest.spyOn(system, "getUpdateSource").mockResolvedValue(custom());
    jest
      .spyOn(system, "getServices")
      .mockResolvedValue([pod("ghcr.io/example/api:testing")]);
    expect(await system.getOutdated()).toEqual([
      expect.objectContaining({
        currentImage: "ghcr.io/example/api:testing",
        targetImage: "ghcr.io/example/api:testing",
        newVersion: digest("b"),
        canUpdate: true,
        source: "custom",
      }),
    ]);
  });
  it("does not report a new index alias for the same running bytes as an update", async () => {
    jest
      .spyOn(system, "getUpdateSource")
      .mockResolvedValue(installedUpdateSource());
    jest
      .spyOn(system, "getServices")
      .mockResolvedValue([
        pod("ghcr.io/example/api:testing", [digest("a"), digest("b")]),
      ]);
    expect(await system.getOutdated()).toEqual([]);
  });
  it("keeps an exact current pin without polling a floating tag", async () => {
    const source = parseUpdateSource({
      version: 1,
      mode: "custom",
      images: { ...images(), api: "ghcr.io/example/api@" + digest("a") },
    });
    jest.spyOn(system, "getUpdateSource").mockResolvedValue(source);
    jest
      .spyOn(system, "getServices")
      .mockResolvedValue([pod("ghcr.io/example/api@" + digest("a"))]);
    expect(await system.getOutdated()).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("leaves third-party plugin repositories independent of core channels", async () => {
    jest
      .spyOn(system, "getUpdateSource")
      .mockResolvedValue(
        parseUpdateSource({ version: 1, mode: "official", channel: "beta" }),
      );
    jest.spyOn(system, "getServices").mockResolvedValue([]);
    (system as any).getPluginServices.mockResolvedValue([
      {
        ...pod("ghcr.io/example/inventory:testing"),
        service: "inventory",
        plugin: "Inventory",
      },
    ]);
    expect(await system.getOutdated()).toEqual([
      expect.objectContaining({
        targetImage: "ghcr.io/example/inventory:testing",
        source: "plugin",
      }),
    ]);
  });
});

describe("controller source guards", () => {
  let system: SystemService;
  beforeEach(() => {
    system = new SystemService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(system, "getUpdateSource")
      .mockResolvedValue(installedUpdateSource());
    jest.spyOn(system as any, "getPluginServices").mockResolvedValue([]);
    jest.spyOn(system, "getLatestDigest").mockResolvedValue(digest("b"));
    jest
      .spyOn(system, "getServices")
      .mockResolvedValue([
        {
          service: "game-server-node-connector",
          pod: "connector-old",
          image: "ghcr.io/5stackgg/game-server-node-connector:latest",
          version: digest("a"),
          versions: [digest("a")],
        },
      ]);
  });
  it("does not advertise a restart when an OnDelete Pod differs from its controller source", async () => {
    jest
      .spyOn(system as any, "desiredServiceImage")
      .mockResolvedValue("ghcr.io/example/game-server-node-connector:testing");
    expect(await system.getOutdated()).toEqual([]);
  });
  it("does not advertise an update when the controller is unreadable", async () => {
    jest.spyOn(system as any, "desiredServiceImage").mockResolvedValue(null);
    expect(await system.getOutdated()).toEqual([]);
  });
  it("rechecks the controller immediately before a restart", async () => {
    jest
      .spyOn(system, "getOutdated")
      .mockResolvedValue([
        {
          service: "api",
          pod: "api-test",
          targetImage: "ghcr.io/example/api:testing",
        },
      ] as any);
    jest
      .spyOn(system as any, "desiredServiceImage")
      .mockResolvedValue("ghcr.io/5stackgg/api:latest");
    const restart = jest
      .spyOn(system, "restartService")
      .mockResolvedValue(undefined);
    await expect(system.updateServices()).rejects.toMatchObject({
      status: 409,
    });
    expect(restart).not.toHaveBeenCalled();
  });
  it("allows a restart only when the controller uses the exact selected image", async () => {
    jest
      .spyOn(system, "getOutdated")
      .mockResolvedValue([
        {
          service: "api",
          pod: "api-test",
          targetImage: "ghcr.io/example/api:testing",
        },
      ] as any);
    jest
      .spyOn(system as any, "desiredServiceImage")
      .mockResolvedValue("ghcr.io/example/api:testing");
    const restart = jest
      .spyOn(system, "restartService")
      .mockResolvedValue(undefined);
    await system.updateServices();
    expect(restart).toHaveBeenCalledWith("api", "api-test");
  });
});

describe("digest pin platform manifests", () => {
  it("never restarts an exact pin when the node reports a different platform digest", async () => {
    const system = new SystemService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const image = "ghcr.io/example/inventory@" + digest("a");
    jest
      .spyOn(system, "getUpdateSource")
      .mockResolvedValue(installedUpdateSource());
    jest.spyOn(system, "getServices").mockResolvedValue([]);
    jest.spyOn(system as any, "getPluginServices").mockResolvedValue([
      {
        service: "inventory",
        plugin: "Inventory",
        pod: "inventory-test",
        image,
        version: digest("b"),
        versions: [digest("b")],
      },
    ]);
    const lookup = jest.spyOn(system, "getLatestDigest");
    expect(await system.getOutdated()).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("source preference persistence", () => {
  let system: SystemService;
  let client: any;
  beforeEach(() => {
    system = new SystemService(
      {} as any,
      { mutation: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    client = {
      readNamespacedConfigMap: jest.fn().mockResolvedValue({
        metadata: { resourceVersion: "7" },
        data: { "installed.json": "{}" },
      }),
      patchNamespacedConfigMap: jest.fn().mockResolvedValue({}),
    };
    (system as any).apiClient = client;
  });
  it("saves only the chosen preference and retains installation metadata", async () => {
    const restart = jest
      .spyOn(system, "restartService")
      .mockResolvedValue(undefined);
    await system.saveUpdateSource(custom(), "7");
    expect(
      client.patchNamespacedConfigMap.mock.calls[0][0].body,
    ).toContainEqual({
      op: "add",
      path: "/data",
      value: {
        "installed.json": "{}",
        "profile.json": JSON.stringify(custom()),
      },
    });
    expect(restart).not.toHaveBeenCalled();
  });
  it("rejects a stale editor before writing", async () => {
    await expect(system.saveUpdateSource(custom(), "6")).rejects.toMatchObject({
      status: 409,
    });
    expect(client.patchNamespacedConfigMap).not.toHaveBeenCalled();
  });
  it.each([403, 500])(
    "does not choose a fallback for unreadable selected configuration (%s)",
    async (code) => {
      client.readNamespacedConfigMap.mockRejectedValue({ code });
      await expect(system.getUpdateSource()).rejects.toMatchObject({
        status: 503,
      });
    },
  );
});

describe("panel repository isolation", () => {
  let system: SystemService;
  let lookup: jest.SpyInstance;
  beforeEach(() => {
    system = new SystemService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(system, "getPanelVersion").mockResolvedValue("a".repeat(40));
    lookup = jest
      .spyOn(system as any, "getLatestPanelVersion")
      .mockResolvedValue("b".repeat(40));
  });
  it("does not check official main for an image-only custom installation", async () => {
    const result = await (system as any).panelUpdateStatus(custom(), null);
    expect(result.status).toBe("pinned");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("checks exactly the chosen custom repository and ref", async () => {
    const panel = { repository: "example/panel", ref: "testing" };
    const result = await (system as any).panelUpdateStatus(
      { ...custom(), panel },
      { panel: { ...panel, sha: "a".repeat(40) } },
    );
    expect(lookup.mock.calls).toEqual([[panel]]);
    expect(result).toMatchObject({
      repository: panel.repository,
      ref: panel.ref,
      status: "update",
      canUpdate: false,
    });
  });
  it("requires a host source switch when official beta differs from installed custom builds", async () => {
    const result = await (system as any).panelUpdateStatus(
      parseUpdateSource({ version: 1, mode: "official", channel: "beta" }),
      {
        panel: {
          repository: "example/panel",
          ref: "testing",
          sha: "a".repeat(40),
        },
      },
    );
    expect(lookup.mock.calls).toEqual([
      [{ repository: "5stackgg/5stack-panel", ref: "beta" }],
    ]);
    expect(result.status).toBe("source-change");
  });
});
