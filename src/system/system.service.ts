import fetch from "node-fetch";
import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import {
  CoreV1Api,
  KubeConfig,
  AppsV1Api,
  setHeaderOptions,
  PatchStrategy,
  V1Node,
  Watch,
} from "@kubernetes/client-node";
import { HasuraService } from "src/hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { TailscaleConfig } from "src/configs/types/TailscaleConfig";
import { DiscordConfig } from "src/configs/types/DiscordConfig";
import { SteamConfig } from "src/configs/types/SteamConfig";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemSettingName } from "./enums/SystemSettingName";
import { GameServersConfig } from "src/configs/types/GameServersConfig";

@Injectable()
export class SystemService {
  private kubeConfig: KubeConfig;
  private apiClient: CoreV1Api;
  private appsClient: AppsV1Api;

  private static readonly POD_WATCH_RETRY_MS = 5 * 1000;

  private featuresDetected = false;

  private static TRACKED_APPS = [
    "api",
    "web",
    "game-server-node-connector",
    "game-server-node-connector-nvidia",
    "demo-parser",
    "hasura",
  ];

  // One build: hasura's init container migrates with the api image, and only
  // when the hasura pod is replaced.
  private static API_PAIR = ["api", "hasura"];

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
    this.kubeConfig = kc;
    this.apiClient = kc.makeApiClient(CoreV1Api);
    this.appsClient = kc.makeApiClient(AppsV1Api);
  }

  // An update is a rollout, and the versions read as current only once the
  // rollout's old pods are gone: getServices reads every pod's image, the
  // terminating ones included. So each one going is when to check again.
  public watchServicePods(onPodGone: () => void) {
    const watch = new Watch(this.kubeConfig);
    let failing = false;

    const start = () => {
      let retried = false;
      const retry = (error?: unknown) => {
        if (retried) {
          return;
        }
        retried = true;

        if (error && !failing) {
          this.logger.warn(
            `unable to watch service pods, retrying every ${SystemService.POD_WATCH_RETRY_MS / 1000}s: ${(error as Error)?.message ?? error}`,
          );
        }
        failing = !!error;

        setTimeout(start, SystemService.POD_WATCH_RETRY_MS).unref?.();
      };

      watch
        .watch(
          "/api/v1/namespaces/5stack/pods",
          { labelSelector: `app in (${SystemService.TRACKED_APPS.join(",")})` },
          (phase) => {
            failing = false;

            if (phase === "DELETED") {
              onPodGone();
            }
          },
          retry,
        )
        .catch(retry);
    };

    start();
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
    for (const { service, pod } of await this.getOutdated()) {
      void this.restartService(service, pod);
    }
  }

  // Either pod can be replaced on its own and re-pull :latest. Compared with
  // each other, not the registry: its digest is cached for 5 minutes, and a
  // hasura pod that pulled past it read as behind on every check.
  public async syncApiAndHasura() {
    if (process.env.DEV) {
      return;
    }

    const services = await this.getServices();
    const api = services.filter(({ service }) => service === "api");
    const hasura = services.filter(({ service }) => service === "hasura");

    if (
      api.length === 0 ||
      hasura.length === 0 ||
      // A pod with no digest yet is still pulling, and pods on two builds are
      // mid-rollout. Restarting then kills the new hasura pod's migrations.
      ![api, hasura].every((pods) =>
        pods.every((pod) => SystemService.sameBuild(pod, pods[0])),
      ) ||
      SystemService.sameBuild(api[0], hasura[0])
    ) {
      return;
    }

    this.logger.warn(
      `api ${api[0].version} and hasura ${hasura[0].version} run different builds, restarting both`,
    );

    await this.restartDeployment("hasura");
    await this.restartDeployment("api");
  }

  private static sameBuild(
    a: { versions: string[] },
    b: { versions: string[] },
  ) {
    return a.versions.some((version) => b.versions.includes(version));
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

    const panelVersion = await this.getPanelVersion();
    const latestPanelVersion = await this.getLatestPanelVersion();

    if (panelVersion !== latestPanelVersion) {
      hasUpdates.push({
        service: "panel",
        currentVersion: panelVersion,
        newVersion: latestPanelVersion,
      });
    }

    hasUpdates.push(...(await this.getOutdated()));

    const value = JSON.stringify(hasUpdates);

    // Every settings write fires the event trigger that re-applies the
    // match_options column defaults with ALTER TABLE.
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
  public async getOutdated() {
    const checked: Array<{
      service: string;
      plugin?: string;
      pod: string;
      currentVersion: string;
      newVersion: string;
      current: boolean;
    }> = [];

    const services: Array<{
      pod: string;
      service: string;
      plugin?: string;
      image: string;
      version: string;
      versions: string[];
    }> = [...(await this.getServices()), ...(await this.getPluginServices())];

    for (const { service, plugin, pod, image, version, versions } of services) {
      const newVersion = await this.getLatestDigest(image);

      // An unreadable registry or pod tells us nothing. Reporting on it would
      // show a phantom update; restarting on it would be an endless rollout.
      if (!image || !version || !newVersion) {
        continue;
      }

      checked.push({
        service,
        plugin,
        pod,
        currentVersion: version,
        newVersion,
        current: versions.includes(newVersion),
      });
    }

    const pairOutdated = checked.some(
      ({ service, current }) =>
        SystemService.API_PAIR.includes(service) && !current,
    );

    return checked
      .filter(
        ({ service, current }) =>
          !current ||
          (pairOutdated && SystemService.API_PAIR.includes(service)),
      )
      .map(({ service, plugin, pod, currentVersion, newVersion }) => ({
        service,
        plugin,
        pod,
        currentVersion,
        newVersion,
      }));
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

  private async getLatestPanelVersion() {
    return await this.cache.remember<string>(
      this.getServiceCacheKey("panel"),
      async () => {
        try {
          const response = await fetch(
            "https://api.github.com/repos/5stackgg/5stack-panel/commits/main",
          );
          const { sha } = await response.json();
          return sha;
        } catch (error) {
          this.logger.warn("Unable to fetch latest panel version", error);
          return "";
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
          await this.setMatchOptionsDefault(
            "default_models",
            setting.value === "true" ? "true" : "false",
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

          await this.setMatchOptionsDefault(
            "veto_pick_timeout",
            String(vetoPickTimeout),
          );
          break;
        }
        default:
          break;
      }
    }
  }

  // Runs on every settings write, and an ALTER waiting on a lock queues every
  // reader of match_options behind it. So it only runs when the default is
  // changing, and gives up quickly instead of waiting out the statement timeout.
  private async setMatchOptionsDefault(
    column: "default_models" | "veto_pick_timeout",
    value: string,
  ) {
    const [current] = await this.postgres.query<
      Array<{ column_default: string | null }>
    >(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'match_options' AND column_name = $1`,
      [column],
    );

    if (current?.column_default === value) {
      return;
    }

    await this.postgres.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        `ALTER TABLE "public"."match_options" ALTER COLUMN "${column}" SET DEFAULT ${value}`,
      );
    });
  }
}
