import fetch from "node-fetch";
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import {
  CoreV1Api,
  KubeConfig,
  AppsV1Api,
  setHeaderOptions,
  PatchStrategy,
  V1Node,
} from "@kubernetes/client-node";
import { HasuraService } from "src/hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { TailscaleConfig } from "src/configs/types/TailscaleConfig";
import { DiscordConfig } from "src/configs/types/DiscordConfig";
import { SteamConfig } from "src/configs/types/SteamConfig";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemSettingName } from "./enums/SystemSettingName";
import { GameServersConfig } from "src/configs/types/GameServersConfig";

import {
  UPDATE_SOURCE_CONFIG_MAP,
  UPDATE_SOURCE_COMPONENTS,
  UpdateSource,
  PanelSource,
  installedUpdateSource,
  parseUpdateSource,
  sourceImage,
  sourceLabel,
  imageDigestReference,
  validPanelSource,
} from "./update-source";

@Injectable()
export class SystemService {
  private apiClient: CoreV1Api;
  private appsClient: AppsV1Api;

  private featuresDetected = false;

  private static TRACKED_APPS = [
    "api",
    "web",
    "game-server-node-connector",
    "game-server-node-connector-nvidia",
    "demo-parser",
    "hasura",
  ];

  // Deployment names a plugin is never allowed to claim. A plugin manifest
  // is third-party input, so without this a plugin declaring `deployments:
  // ["api"]` would render an Update button that restarts the panel itself.
  private static RESERVED_DEPLOYMENTS = [
    ...SystemService.TRACKED_APPS,
    "panel",
    "typesense",
    "timescaledb",
    "redis",
    "rustfs",
    // Still live after the RustFS migration: the panel keeps it as a Service
    // alias onto the rustfs pods.
    "minio",
    "mediamtx",
  ];

  public static isReservedDeployment(name: string) {
    return SystemService.RESERVED_DEPLOYMENTS.includes(name);
  }

  public static readonly IMPORTED_HIGHLIGHT_SETTINGS = [
    SystemSettingName.AutoGenerateMatchClips,
    SystemSettingName.AutoGenerateMatchClipsImported,
  ];

  public static readonly TWITCH_SETTINGS = [
    SystemSettingName.TwitchClientId,
    SystemSettingName.TwitchClientSecret,
  ];

  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.apiClient = kc.makeApiClient(CoreV1Api);
    this.appsClient = kc.makeApiClient(AppsV1Api);
  }

  public async getSetting<T extends string | number | boolean>(
    name: SystemSettingName,
    defaultValue: T,
  ): Promise<T> {
    const [data] = await this.postgres.query<
      Array<{
        value: string;
      }>
    >(`SELECT value FROM public.settings WHERE name = $1 LIMIT 1`, [name]);

    if (data?.value !== undefined && data?.value !== null) {
      // Try to convert the string value to the type of defaultValue
      if (typeof defaultValue === "boolean") {
        return (data.value === "true") as T;
      } else if (typeof defaultValue === "number") {
        const num = Number(data.value);
        return (isNaN(num) ? defaultValue : num) as T;
      } else {
        return data.value as T;
      }
    }
    return defaultValue;
  }

  public async detectFeatures() {
    try {
      const tailscaleConfig = this.config.get<TailscaleConfig>("tailscale");

      let supportsGameServerNodes = false;
      if (
        tailscaleConfig.key &&
        tailscaleConfig.secret &&
        tailscaleConfig.netName
      ) {
        supportsGameServerNodes = true;
      }

      await this.hasura.mutation({
        insert_settings_one: {
          __args: {
            object: {
              name: SystemSettingName.SupportsGameServerNodes,
              value: supportsGameServerNodes.toString(),
            },
            on_conflict: {
              constraint: "settings_pkey",
              update_columns: ["value"],
            },
          },
          __typename: true,
        },
      });

      const discordConfig = this.config.get<DiscordConfig>("discord");

      let supportsDiscordBot = false;
      if (
        discordConfig.clientId &&
        discordConfig.clientSecret &&
        discordConfig.token
      ) {
        supportsDiscordBot = true;
      }

      await this.hasura.mutation({
        insert_settings_one: {
          __args: {
            object: {
              name: SystemSettingName.SupportsDiscordBot,
              value: supportsDiscordBot.toString(),
            },
            on_conflict: {
              constraint: "settings_pkey",
              update_columns: ["value"],
            },
          },
          __typename: true,
        },
      });

      const steamConfig = this.config.get<SteamConfig>("steam");

      let supportsGameServerNodeVersionPinning = false;
      if (steamConfig.steamUser && steamConfig.steamPassword) {
        supportsGameServerNodeVersionPinning = true;
      }

      await this.hasura.mutation({
        insert_settings_one: {
          __args: {
            object: {
              name: SystemSettingName.SupportsGameServerVersionPinning,
              value: supportsGameServerNodeVersionPinning.toString(),
            },
            on_conflict: {
              constraint: "settings_pkey",
              update_columns: ["value"],
            },
          },
          __typename: true,
        },
      });

      const { serverImageOverride } =
        this.config.get<GameServersConfig>("gameServers");

      await this.hasura.mutation({
        insert_settings_one: {
          __args: {
            object: {
              name: SystemSettingName.GameServerPluginRuntimeLocked,
              value: (!!serverImageOverride).toString(),
            },
            on_conflict: {
              constraint: "settings_pkey",
              update_columns: ["value"],
            },
          },
          __typename: true,
        },
      });

      await this.syncImportedHighlightsSupport();

      await this.syncTwitchSupport();

      this.featuresDetected = true;
    } catch (error) {
      this.logger.warn("Error detecting features", error);
      setTimeout(() => {
        void this.detectFeatures();
      }, 5000);
    }
  }

  public async syncImportedHighlightsSupport() {
    const values = await Promise.all(
      SystemService.IMPORTED_HIGHLIGHT_SETTINGS.map((name) =>
        this.getSetting<string>(name, "false"),
      ),
    );

    // "1" counts as on because ClipsService.readBoolSetting reads it that way.
    const supported = values.every(
      (value) => value === "true" || value === "1",
    );

    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: SystemSettingName.SupportsImportedHighlights,
            value: supported.toString(),
          },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });
  }

  public async syncTwitchSupport() {
    const values = await Promise.all(
      SystemService.TWITCH_SETTINGS.map((name) =>
        this.getSetting<string>(name, ""),
      ),
    );

    const supported = values.every((value) => value.trim() !== "");

    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: SystemSettingName.SupportsTwitch,
            value: supported.toString(),
          },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });
  }

  public async updateServices() {
    const chosen = JSON.stringify(await this.getUpdateSource());
    for (const { service, pod } of await this.getOutdated()) {
      if (JSON.stringify(await this.getUpdateSource()) !== chosen) {
        throw new ConflictException(
          "The update source changed; check updates again",
        );
      }
      await this.restartService(service, pod);
    }
  }

  public async restartService(service: string, pod?: string) {
    try {
      await this.restartDeployment(service);
    } catch (error) {
      this.logger.log(
        `Failed to rollout deployment ${service}, restarting pod ${pod}`,
        error,
      );
      if (pod) {
        this.logger.warn(
          `Failed to rollout deployment ${service}, restarting pod ${pod}`,
        );
        await this.restartPod(pod);
      }
    }
  }

  public async setVersions() {
    const hasUpdates = [];

    const { source, installed } = await this.updateSourceDocument();
    const panel = await this.panelUpdateStatus(source, installed);
    if (panel.status === "update") hasUpdates.push(panel);

    hasUpdates.push(...(await this.getOutdated()));

    const value = JSON.stringify(hasUpdates);

    // Runs every minute, and every settings write fires the event trigger that
    // re-applies the match_options column defaults with ALTER TABLE.
    if (value === (await this.getSetting(SystemSettingName.Updates, ""))) {
      return;
    }

    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: SystemSettingName.Updates,
            value,
          },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });
  }

  // Everything whose running image digest no longer matches the digest its tag
  // points at. Shared by setVersions (report it) and updateServices (apply it),
  // so the header list and the Update button can never disagree.
  private async updateSourceDocument() {
    try {
      const document = await this.apiClient.readNamespacedConfigMap({
        name: UPDATE_SOURCE_CONFIG_MAP,
        namespace: "5stack",
      });
      const source = document.data?.["profile.json"]
        ? parseUpdateSource(JSON.parse(document.data["profile.json"]))
        : installedUpdateSource();
      const installed = document.data?.["installed.json"]
        ? JSON.parse(document.data["installed.json"])
        : null;
      return { document, source, installed, writable: true };
    } catch (error) {
      const code = error?.code ?? error?.statusCode ?? error?.body?.code;
      if (code === 404) {
        return {
          document: null,
          source: installedUpdateSource(),
          installed: null,
          writable: false,
        };
      }
      throw new ServiceUnavailableException(
        "The selected update source cannot be read",
      );
    }
  }

  public async getUpdateSource(): Promise<UpdateSource> {
    return (await this.updateSourceDocument()).source;
  }

  public async saveUpdateSource(value: unknown, resourceVersion: string) {
    let source: UpdateSource;
    try {
      source = parseUpdateSource(value);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
    const { document } = await this.updateSourceDocument();
    if (!document)
      throw new ServiceUnavailableException(
        "Run the panel updater to enable update-source settings",
      );
    if (
      !resourceVersion ||
      resourceVersion !== document.metadata.resourceVersion
    ) {
      throw new ConflictException(
        "The update source changed; reload before saving",
      );
    }
    try {
      await this.apiClient.patchNamespacedConfigMap(
        {
          name: UPDATE_SOURCE_CONFIG_MAP,
          namespace: "5stack",
          body: [
            {
              op: "test",
              path: "/metadata/resourceVersion",
              value: resourceVersion,
            },
            {
              op: "add",
              path: "/data",
              value: {
                ...document.data,
                "profile.json": JSON.stringify(source),
              },
            },
          ],
        },
        setHeaderOptions("Content-Type", PatchStrategy.JsonPatch),
      );
    } catch (error) {
      if ([409, 422].includes(error?.code ?? error?.statusCode)) {
        throw new ConflictException(
          "The update source changed; reload before saving",
        );
      }
      throw new ServiceUnavailableException("Unable to save the update source");
    }
    // Saving a preference never changes a running image or restarts a workload.
    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: { name: SystemSettingName.Updates, value: "[]" },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });
    return { source, applied: false };
  }

  private async currentCoreImages() {
    const images: Record<string, string> = {};
    for (const service of ["api", "web", "demo-parser"]) {
      try {
        const deployment = await this.appsClient.readNamespacedDeployment({
          name: service,
          namespace: "5stack",
        });
        images[service] =
          deployment.spec?.template?.spec?.containers?.[0]?.image;
      } catch {
        /* Missing services remain explicit in the form. */
      }
    }
    try {
      const connector = await this.appsClient.readNamespacedDaemonSet({
        name: "game-server-node-connector",
        namespace: "5stack",
      });
      images["game-server-node-connector"] =
        connector.spec?.template?.spec?.containers?.[0]?.image;
    } catch {
      /* Older RBAC can still report the actual running reference. */
    }
    for (const item of await this.getServices())
      images[item.service] ??= item.image;
    const game = this.config.get<GameServersConfig>("gameServers");
    images["game-streamer"] =
      game?.gameStreamerImage ?? "ghcr.io/5stackgg/game-streamer:latest";
    images["game-server-sw"] =
      game?.serverImageOverride ??
      game?.pluginRuntimeImages?.swiftlys2 ??
      "ghcr.io/5stackgg/game-server-sw:latest";
    images["game-server-css"] =
      game?.serverImageOverride ??
      game?.pluginRuntimeImages?.counterstrikesharp ??
      "ghcr.io/5stackgg/game-server-css:latest";
    return Object.fromEntries(
      UPDATE_SOURCE_COMPONENTS.map((name) => [name, images[name] ?? ""]),
    );
  }

  private async serviceUpdateStatus(source: UpdateSource) {
    const services: Array<{
      service: string;
      plugin?: string;
      pod: string;
      image: string;
      version: string;
      versions: string[];
    }> = [...(await this.getServices()), ...(await this.getPluginServices())];
    return await Promise.all(
      services.map(
        async ({ service, plugin, pod, image, version, versions }) => {
          // A plugin retains its own repository; core channel selection cannot replace third-party plugins.
          const targetImage = plugin
            ? image
            : sourceImage(source, service, image);
          const pinned = imageDigestReference(targetImage);
          const newVersion =
            pinned ?? (await this.getLatestDigest(targetImage));
          const known = versions ?? [version];
          const matches = !!newVersion && known.includes(newVersion);
          const sourceChange = image !== targetImage;
          const status =
            !image || !version || !newVersion
              ? "unavailable"
              : sourceChange
                ? "source-change"
                : matches
                  ? pinned
                    ? "pinned"
                    : "current"
                  : "update";
          return {
            service,
            plugin,
            pod,
            currentImage: image,
            targetImage,
            currentVersion: version,
            newVersion,
            source: plugin ? "plugin" : sourceLabel(source),
            status,
            canUpdate: status === "update",
          };
        },
      ),
    );
  }

  private async panelUpdateStatus(source: UpdateSource, installed: any) {
    const target =
      source.mode === "installed" ? installed?.panel : source.panel;
    const currentVersion =
      installed?.panel?.sha ?? (await this.getPanelVersion());
    if (!target)
      return {
        service: "panel",
        currentImage: installed?.panel
          ? installed.panel.repository + "@" + installed.panel.ref
          : undefined,
        currentVersion,
        status: "pinned",
        canUpdate: false,
      };
    if (!validPanelSource(target))
      return {
        service: "panel",
        currentVersion,
        status: "unavailable",
        canUpdate: false,
      };
    const newVersion = await this.getLatestPanelVersion(target);
    const sameSource =
      installed?.panel?.repository === target.repository &&
      installed?.panel?.ref === target.ref;
    return {
      service: "panel",
      currentImage: installed?.panel
        ? installed.panel.repository + "@" + installed.panel.ref
        : undefined,
      currentVersion,
      newVersion,
      repository: target.repository,
      ref: target.ref,
      source: sourceLabel(source),
      status: !newVersion
        ? "unavailable"
        : !sameSource
          ? "source-change"
          : currentVersion === newVersion
            ? "current"
            : "update",
      // Host manifests and database migrations must run through the host updater.
      canUpdate: false,
    };
  }

  public async getUpdateSourceStatus() {
    const { document, source, installed, writable } =
      await this.updateSourceDocument();
    const [services, panel, installedImages] = await Promise.all([
      this.serviceUpdateStatus(source),
      this.panelUpdateStatus(source, installed),
      this.currentCoreImages(),
    ]);
    const runtime = await Promise.all(
      ["game-streamer", "game-server-sw", "game-server-css"].map(
        async (service) => {
          const currentImage = installedImages[service];
          const targetImage = sourceImage(source, service, currentImage);
          const pinned = imageDigestReference(targetImage);
          const newVersion =
            pinned ?? (await this.getLatestDigest(targetImage));
          return {
            service,
            currentImage,
            targetImage,
            currentVersion: imageDigestReference(currentImage),
            newVersion,
            source: sourceLabel(source),
            canUpdate: false,
            status: !newVersion
              ? "unavailable"
              : currentImage !== targetImage
                ? "source-change"
                : pinned
                  ? "pinned"
                  : "on-demand",
          };
        },
      ),
    );
    return {
      source,
      writable,
      resourceVersion: document?.metadata?.resourceVersion ?? null,
      installedImages,
      panel,
      services: [...services, ...runtime],
      applyMethod: "host-updater",
      checkedAt: new Date().toISOString(),
    };
  }

  public async getOutdated() {
    const source = await this.getUpdateSource();
    return (await this.serviceUpdateStatus(source)).filter(
      (item) => item.canUpdate,
    );
  }

  // The digest the given tag currently points at, or null if the registry is
  // unreachable/unauthenticated. Never throws: a plugin pointed at a broken or
  // private registry must not take down the check for api/web.
  public async getLatestDigest(image: string): Promise<string | null> {
    const ref = SystemService.parseImageRef(image);

    if (!ref) {
      return null;
    }

    const { registry, repository, tag } = ref;

    try {
      return await this.cache.remember<string>(
        this.getServiceCacheKey(`${registry}/${repository}:${tag}`),
        async () => {
          const token = await this.getRegistryToken(registry, repository);

          const response = await fetch(
            `https://${registry === "docker.io" ? "registry-1.docker.io" : registry}/v2/${repository}/manifests/${tag}`,
            {
              signal: AbortSignal.timeout(5000),
              headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                // Multi-arch images answer with an index, single-arch ones with
                // a plain manifest. Third-party plugins publish both, so accept
                // either rather than 404ing on the ones that aren't multi-arch.
                Accept: [
                  "application/vnd.oci.image.index.v1+json",
                  "application/vnd.docker.distribution.manifest.list.v2+json",
                  "application/vnd.oci.image.manifest.v1+json",
                  "application/vnd.docker.distribution.manifest.v2+json",
                ].join(","),
              },
            },
          );

          if (!response.ok) {
            throw new Error(
              `Failed to fetch manifest [${image}]: ${response.statusText}`,
            );
          }

          return response.headers.get("docker-content-digest");
        },
        300,
      );
    } catch (error) {
      this.logger.warn(
        `[updates] registry lookup failed for ${image}: ${error?.message ?? error}`,
      );
      return null;
    }
  }

  public static parseImageRef(image: string) {
    // A digest-pinned image has nothing to poll -- the reference already names
    // the exact bytes, so it can never be out of date.
    if (!image || image.includes("@")) {
      return null;
    }

    let remainder = image;
    let registry = "docker.io";

    const slash = remainder.indexOf("/");
    const host = slash === -1 ? "" : remainder.slice(0, slash);
    if (host.includes(".") || host.includes(":") || host === "localhost") {
      registry = host;
      remainder = remainder.slice(slash + 1);
    }

    let tag = "latest";
    const colon = remainder.lastIndexOf(":");
    if (colon !== -1 && !remainder.slice(colon + 1).includes("/")) {
      tag = remainder.slice(colon + 1);
      remainder = remainder.slice(0, colon);
    }

    if (!remainder) {
      return null;
    }

    return {
      registry,
      // Official Docker Hub images are addressed as library/<name>.
      repository:
        registry === "docker.io" && !remainder.includes("/")
          ? `library/${remainder}`
          : remainder,
      tag,
    };
  }

  public async restartPod(pod: string) {
    await this.apiClient.deleteNamespacedPod({
      name: pod,
      namespace: "5stack",
    });

    this.logger.log(`Successfully restarted pod ${pod}`);
  }

  public async restartDeployment(deploymentName: string, namespace = "5stack") {
    await this.appsClient.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace,
        body: {
          spec: {
            template: {
              metadata: {
                annotations: {
                  "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
                },
              },
            },
          },
        },
      },
      setHeaderOptions("Content-Type", PatchStrategy.StrategicMergePatch),
    );

    this.logger.log(`Successfully restarted deployment ${deploymentName}`);
  }

  public async getServices() {
    const services: Array<{
      pod: string;
      service: string;
      image: string;
      version: string;
      versions: string[];
    }> = [];

    for (const { pod, node } of await this.readyPods()) {
      const service = pod.metadata.labels?.app;

      if (!SystemService.TRACKED_APPS.includes(service)) {
        continue;
      }

      // hasura runs the graphql engine, but it's the api image in its init
      // container that tracks the panel's version.
      const [spec, status] =
        service === "hasura"
          ? [
              pod.spec?.initContainers?.[0],
              pod.status?.initContainerStatuses?.[0],
            ]
          : [pod.spec?.containers?.[0], pod.status?.containerStatuses?.[0]];

      services.push({
        pod: pod.metadata.name,
        service,
        image: spec?.image,
        version: SystemService.imageDigest(status?.imageID),
        versions: SystemService.imageDigests(node, status?.imageID),
      });
    }

    return services;
  }

  // Deployments declared by registered plugins. The image is read off the
  // live deployment rather than the plugin manifest, so it can never drift from
  // what is actually running -- the manifest only supplies the name.
  private async getPluginServices() {
    const services: Array<{
      pod: string;
      service: string;
      plugin: string;
      image: string;
      version: string;
      versions: string[];
    }> = [];

    let customPages: Array<{ title: string; deployments: unknown }>;

    try {
      ({ custom_pages: customPages } = await this.hasura.query({
        custom_pages: {
          __args: {
            where: {
              enabled: {
                _eq: true,
              },
            },
          },
          title: true,
          deployments: true,
        },
      }));
    } catch (error) {
      this.logger.warn("unable to fetch plugins", error);
      return services;
    }

    for (const { title, deployments } of customPages) {
      if (!Array.isArray(deployments) || deployments.length === 0) {
        continue;
      }

      for (const name of deployments) {
        if (typeof name !== "string") {
          continue;
        }

        if (SystemService.isReservedDeployment(name)) {
          this.logger.warn(
            `plugin "${title}" tried to claim reserved deployment "${name}"`,
          );
          continue;
        }

        try {
          const deployment = await this.appsClient.readNamespacedDeployment({
            name,
            namespace: "5stack",
          });

          const image = deployment.spec?.template?.spec?.containers?.[0]?.image;

          if (!image) {
            continue;
          }

          const [ready] = await this.readyPods(
            Object.entries(deployment.spec?.selector?.matchLabels ?? {})
              .map(([label, value]) => `${label}=${value}`)
              .join(","),
          );

          if (!ready) {
            continue;
          }

          const { pod, node } = ready;
          const imageID = pod.status?.containerStatuses?.[0]?.imageID;

          services.push({
            pod: pod.metadata.name,
            service: name,
            plugin: title,
            image,
            version: SystemService.imageDigest(imageID),
            versions: SystemService.imageDigests(node, imageID),
          });
        } catch (error) {
          // A plugin can name a deployment that was never installed, or was
          // removed out from under it. That's its problem, not the panel's.
          this.logger.warn(
            `unable to inspect plugin deployment ${name}`,
            error?.body?.message ?? error?.message ?? error,
          );
        }
      }
    }

    return services;
  }

  private async readyPods(labelSelector?: string) {
    const nodes = await this.apiClient.listNode();

    const podList = await this.apiClient.listNamespacedPod({
      namespace: "5stack",
      labelSelector,
    });

    return podList.items
      .map((pod) => ({
        pod,
        node: nodes.items.find((node) => {
          return node.metadata.name === pod.spec?.nodeName;
        }),
      }))
      .filter(({ pod, node }) => {
        if (pod.metadata.labels?.codepier) {
          return false;
        }

        return (
          node?.status?.conditions.find(
            (condition) => condition.type === "Ready",
          )?.status === "True"
        );
      });
  }

  private static imageDigest(imageID?: string) {
    return imageID?.includes("@") ? imageID.split("@")[1] : undefined;
  }

  // Every digest the node knows the running image by. containerd reports a
  // pod's imageID as the first of its image's repo digests in sorted order,
  // not the one it last pulled. A rebuild that changes nothing in the image
  // still moves the tag to a new index digest (its provenance attestation
  // differs), and the re-pull only adds that digest to the image already on
  // the node, so the pod can keep reporting the old one however often it is
  // restarted.
  private static imageDigests(node: V1Node | undefined, imageID?: string) {
    const version = SystemService.imageDigest(imageID);

    if (!version) {
      return [];
    }

    // kubelet lists a bounded number of images per node; one that didn't make
    // the list is only known by the digest the pod reports.
    const names =
      node?.status?.images?.find(({ names }) =>
        names?.some((name) => SystemService.imageDigest(name) === version),
      )?.names ?? [];

    return [
      ...new Set([
        version,
        ...names.map((name) => SystemService.imageDigest(name)).filter(Boolean),
      ]),
    ];
  }

  private async getRegistryToken(registry: string, repository: string) {
    const scope = `repository:${repository}:pull`;

    const response = await fetch(
      registry === "docker.io"
        ? `https://auth.docker.io/token?service=registry.docker.io&scope=${scope}`
        : `https://${registry}/token?scope=${scope}`,
      { signal: AbortSignal.timeout(5000) },
    );

    if (!response.ok) {
      // Not every registry issues anonymous tokens; try the manifest without
      // one rather than giving up here.
      return null;
    }

    const { token } = (await response.json()) as { token?: string };

    return token ?? null;
  }

  private getServiceCacheKey(service: string) {
    return `version:v2:${service}`;
  }

  public async getPanelVersion() {
    try {
      const nodeList = await this.apiClient.listNode({
        labelSelector: "node-role.kubernetes.io/control-plane",
      });

      return nodeList.items.at(0)?.metadata.labels["5stack-panel-version"];
    } catch (error) {
      this.logger.warn("unable to fetch panel version", error);
      return "";
    }
  }

  private async getLatestPanelVersion(
    source: PanelSource,
  ): Promise<string | null> {
    return await this.cache.remember<string | null>(
      this.getServiceCacheKey("panel:" + source.repository + ":" + source.ref),
      async () => {
        try {
          const response = await fetch(
            "https://api.github.com/repos/" +
              source.repository +
              "/commits/" +
              encodeURIComponent(source.ref),
            {
              signal: AbortSignal.timeout(5000),
              headers: { Accept: "application/vnd.github+json" },
            },
          );
          if (!response.ok) return null;
          const { sha } = await response.json();
          return typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)
            ? sha
            : null;
        } catch {
          return null;
        }
      },
      300,
    );
  }

  public async updateDefaultOptions() {
    const { settings } = await this.hasura.query({
      settings: {
        name: true,
        value: true,
      },
    });

    for (const setting of settings) {
      switch (setting.name) {
        case SystemSettingName.PublicDefaultModels:
          await this.postgres.query(
            `ALTER TABLE "public"."match_options" ALTER COLUMN "default_models" SET DEFAULT ${setting.value === "true" ? true : false}`,
          );
          break;
        case SystemSettingName.VetoPickTimeout: {
          // Interpolated into DDL, which cannot take a bind parameter, so the
          // value has to be proven to be a plain non-negative integer first.
          const vetoPickTimeout = Number.parseInt(setting.value, 10);

          if (Number.isNaN(vetoPickTimeout) || vetoPickTimeout < 0) {
            this.logger.warn(
              `ignoring invalid ${SystemSettingName.VetoPickTimeout} setting: ${setting.value}`,
            );
            break;
          }

          await this.postgres.query(
            `ALTER TABLE "public"."match_options" ALTER COLUMN "veto_pick_timeout" SET DEFAULT ${vetoPickTimeout}`,
          );
          break;
        }
        default:
          break;
      }
    }
  }
}
