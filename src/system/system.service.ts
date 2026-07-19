import fetch from "node-fetch";
import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import {
  CoreV1Api,
  KubeConfig,
  AppsV1Api,
  setHeaderOptions,
  PatchStrategy,
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

  // Deployment names a custom page is never allowed to claim. A plugin manifest
  // is third-party input, so without this a plugin declaring `deployments:
  // ["api"]` would render an Update button that restarts the panel itself.
  private static RESERVED_DEPLOYMENTS = [
    ...SystemService.TRACKED_APPS,
    "panel",
    "typesense",
    "timescaledb",
    "redis",
    "minio",
    "mediamtx",
  ];

  public static isReservedDeployment(name: string) {
    return SystemService.RESERVED_DEPLOYMENTS.includes(name);
  }

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

      this.featuresDetected = true;
    } catch (error) {
      this.logger.warn("Error detecting features", error);
      setTimeout(() => {
        void this.detectFeatures();
      }, 5000);
    }
  }

  public async updateServices() {
    for (const { service, pod } of await this.getOutdated()) {
      void this.restartService(service, pod);
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

    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: SystemSettingName.Updates,
            value: JSON.stringify(hasUpdates),
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
    const outdated: Array<{
      service: string;
      plugin?: string;
      pod: string;
      currentVersion: string;
      newVersion: string;
    }> = [];

    const services: Array<{
      pod: string;
      service: string;
      plugin?: string;
      image: string;
      version: string;
    }> = [...(await this.getServices()), ...(await this.getPluginServices())];

    for (const { service, plugin, pod, image, version } of services) {
      const newVersion = await this.getLatestDigest(image);

      // An unreadable registry or pod tells us nothing. Reporting on it would
      // show a phantom update; restarting on it would be an endless rollout.
      if (!version || !newVersion || version === newVersion) {
        continue;
      }

      outdated.push({
        service,
        plugin,
        pod,
        currentVersion: version,
        newVersion,
      });
    }

    return outdated;
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
      this.logger.warn(`unable to resolve latest digest for ${image}`, error);
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
    }> = [];

    for (const pod of await this.readyPods()) {
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
      });
    }

    return services;
  }

  // Deployments declared by registered custom pages. The image is read off the
  // live deployment rather than the plugin manifest, so it can never drift from
  // what is actually running -- the manifest only supplies the name.
  private async getPluginServices() {
    const services: Array<{
      pod: string;
      service: string;
      plugin: string;
      image: string;
      version: string;
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
      this.logger.warn("unable to fetch custom pages", error);
      return services;
    }

    for (const { title, deployments } of customPages) {
      if (!Array.isArray(deployments)) {
        continue;
      }

      for (const name of deployments) {
        if (
          typeof name !== "string" ||
          SystemService.isReservedDeployment(name)
        ) {
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

          const [pod] = await this.readyPods(
            Object.entries(deployment.spec?.selector?.matchLabels ?? {})
              .map(([label, value]) => `${label}=${value}`)
              .join(","),
          );

          if (!pod) {
            continue;
          }

          services.push({
            pod: pod.metadata.name,
            service: name,
            plugin: title,
            image,
            version: SystemService.imageDigest(
              pod.status?.containerStatuses?.[0]?.imageID,
            ),
          });
        } catch (error) {
          // A plugin can name a deployment that was never installed, or was
          // removed out from under it. That's its problem, not the panel's.
          this.logger.warn(
            `unable to inspect plugin deployment ${name}`,
            error,
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

    return podList.items.filter((pod) => {
      if (pod.metadata.labels?.codepier) {
        return false;
      }

      const node = nodes.items.find((node) => {
        return node.metadata.name === pod.spec?.nodeName;
      });

      return (
        node?.status?.conditions.find((condition) => condition.type === "Ready")
          ?.status === "True"
      );
    });
  }

  private static imageDigest(imageID?: string) {
    return imageID?.includes("@") ? imageID.split("@")[1] : undefined;
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

  private async getPanelVersion() {
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
          await this.postgres.query(
            `ALTER TABLE "public"."match_options" ALTER COLUMN "default_models" SET DEFAULT ${setting.value === "true" ? true : false}`,
          );
          break;
        default:
          break;
      }
    }
  }
}
