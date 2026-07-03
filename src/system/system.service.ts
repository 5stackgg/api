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
import { ReleaseChannelService } from "src/release-channel/release-channel.service";

@Injectable()
export class SystemService {
  private apiClient: CoreV1Api;
  private appsClient: AppsV1Api;

  private featuresDetected = false;

  private static SERVICE_TO_REGISTRY: Record<string, string> = {
    "game-server-node-connector-nvidia": "game-server-node-connector",
  };

  private static TRACKED_APPS = [
    "api",
    "web",
    "game-server-node-connector",
    "game-server-node-connector-nvidia",
    "demo-parser",
    "hasura",
  ];

  private static CHANNEL_WORKLOADS: Record<
    string,
    { kind: "Deployment" | "DaemonSet"; initContainer?: string }
  > = {
    api: { kind: "Deployment" },
    web: { kind: "Deployment" },
    "demo-parser": { kind: "Deployment" },
    hasura: { kind: "Deployment", initContainer: "migrations" },
    "game-server-node-connector": { kind: "DaemonSet" },
    "game-server-node-connector-nvidia": { kind: "DaemonSet" },
  };

  private serviceRegistry(service: string) {
    return SystemService.SERVICE_TO_REGISTRY[service] ?? service;
  }

  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly releaseChannel: ReleaseChannelService,
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

      this.featuresDetected = true;
    } catch (error) {
      this.logger.warn("Error detecting features", error);
      setTimeout(() => {
        void this.detectFeatures();
      }, 5000);
    }
  }

  public async updateServices() {
    const patchedServices = await this.reconcileChannelImages();
    const services = await this.getServices();
    const latestVersions = await this.getLatestVersions();

    for (const { pod, service, version } of Object.values(services)) {
      if (patchedServices.has(service)) {
        continue;
      }

      const target = latestVersions[this.serviceRegistry(service)];

      if (!target || version === target.digest) {
        continue;
      }

      void this.restartService(service, pod);
    }
  }

  public async reconcileChannelImages(): Promise<Set<string>> {
    const latestVersions = await this.getLatestVersions();
    const patched = new Set<string>();

    for (const [service, workload] of Object.entries(
      SystemService.CHANNEL_WORKLOADS,
    )) {
      const target = latestVersions[this.serviceRegistry(service)];
      if (!target) {
        continue;
      }

      try {
        const container = await this.getWorkloadContainer(service, workload);
        if (!container?.image) {
          continue;
        }

        const currentTag = container.image.match(/:([^:/]+)$/)?.[1] ?? "latest";
        if (currentTag === target.tag) {
          continue;
        }

        const image = container.image.replace(/:[^:/]+$/, `:${target.tag}`);
        await this.setWorkloadImage(service, workload, container.name, image);
        patched.add(service);
      } catch (error) {
        this.logger.warn(
          `Unable to reconcile channel image for ${service}`,
          error,
        );
      }
    }

    return patched;
  }

  private async getWorkloadContainer(
    service: string,
    workload: { kind: "Deployment" | "DaemonSet"; initContainer?: string },
    namespace = "5stack",
  ) {
    try {
      const resource =
        workload.kind === "DaemonSet"
          ? await this.appsClient.readNamespacedDaemonSet({
              name: service,
              namespace,
            })
          : await this.appsClient.readNamespacedDeployment({
              name: service,
              namespace,
            });

      const spec = resource.spec?.template?.spec;

      if (workload.initContainer) {
        return spec?.initContainers?.find(
          (container) => container.name === workload.initContainer,
        );
      }

      return spec?.containers?.[0];
    } catch {
      return undefined;
    }
  }

  private async setWorkloadImage(
    service: string,
    workload: { kind: "Deployment" | "DaemonSet"; initContainer?: string },
    containerName: string,
    image: string,
    namespace = "5stack",
  ) {
    const podSpec = workload.initContainer
      ? { initContainers: [{ name: containerName, image }] }
      : { containers: [{ name: containerName, image }] };

    const patch = {
      name: service,
      namespace,
      body: {
        spec: {
          template: {
            spec: podSpec,
          },
        },
      },
    };

    if (workload.kind === "DaemonSet") {
      await this.appsClient.patchNamespacedDaemonSet(
        patch,
        setHeaderOptions("Content-Type", PatchStrategy.StrategicMergePatch),
      );
    } else {
      await this.appsClient.patchNamespacedDeployment(
        patch,
        setHeaderOptions("Content-Type", PatchStrategy.StrategicMergePatch),
      );
    }

    this.logger.log(`Set ${workload.kind} ${service} image to ${image}`);
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
    } finally {
      const channel = await this.releaseChannel.getReleaseChannel();
      await this.cache.forget(
        this.getServiceCacheKey(channel, this.serviceRegistry(service)),
      );
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

    const channel = await this.releaseChannel.getReleaseChannel();
    const services = await this.getServices();
    const latestVersions = await this.getLatestVersions();

    for (const { service, version, pod } of Object.values(services)) {
      const target = latestVersions[this.serviceRegistry(service)];
      if (target && version !== target.digest) {
        hasUpdates.push({
          service,
          pod,
          currentVersion: version,
          newVersion: target.digest,
        });
      }
    }

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

    const channelStatus = Object.entries(latestVersions)
      .filter(([service]) => service !== "hasura")
      .map(([service, target]) => ({
        service,
        tag: target.tag,
        fellBack: channel === "beta" && target.tag !== "beta",
      }));

    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: SystemSettingName.ReleaseChannelStatus,
            value: JSON.stringify({ channel, services: channelStatus }),
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

  public async getLatestVersions(): Promise<
    Record<string, { digest: string; tag: string }>
  > {
    const channel = await this.releaseChannel.getReleaseChannel();
    const registries = [
      "api",
      "web",
      "game-server-node-connector",
      "demo-parser",
    ];
    const latestVersions: Record<string, { digest: string; tag: string }> = {};

    for (const registry of registries) {
      const data = await this.cache.remember<{
        service: string;
        digest: string;
        tag: string;
      }>(
        this.getServiceCacheKey(channel, registry),
        async () => {
          const { digest, tag } = await this.fetchChannelManifest(
            registry,
            channel,
          );
          return { service: registry, digest, tag };
        },
        300,
      );

      latestVersions[data.service] = { digest: data.digest, tag: data.tag };
    }

    latestVersions.hasura = latestVersions.api;

    return latestVersions;
  }

  private async fetchChannelManifest(registry: string, channel: string) {
    const tags = channel === "latest" ? ["latest"] : ["beta", "latest"];

    const token = await this.getToken(registry);

    let lastError: string;
    for (const tag of tags) {
      const response = await fetch(
        `https://ghcr.io/v2/5stackgg/${registry}/manifests/${tag}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.oci.image.index.v1+json",
          },
        },
      );

      if (response.ok) {
        return {
          digest: response.headers.get("docker-content-digest"),
          tag,
        };
      }

      lastError = response.statusText;
    }

    throw new Error(`Failed to fetch manifest [${registry}]: ${lastError}`);
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
    const nodes = await this.apiClient.listNode();

    let podList = await this.apiClient.listNamespacedPod({
      namespace: "5stack",
    });

    const pods = podList.items.filter((pod) => {
      if (pod.metadata.labels.codepier) {
        return false;
      }

      const node = nodes.items.find((node) => {
        return node.metadata.name === pod.spec?.nodeName;
      });

      const status = node?.status?.conditions.find(
        (condition) => condition.type === "Ready",
      )?.status;

      if (status !== "True") {
        return false;
      }

      return SystemService.TRACKED_APPS.includes(pod.metadata.labels.app);
    });

    const services: Array<{ pod: string; service: string; version: string }> =
      [];

    for (const pod of pods) {
      const service = pod.metadata.labels.app;
      services.push({
        pod: pod.metadata.name,
        service,
        version: await this.getServiceVersion(service, pod.metadata.name),
      });
    }

    return services;
  }

  private async getServiceVersion(service: string, podName: string) {
    try {
      const pod = await this.apiClient.readNamespacedPod({
        name: podName,
        namespace: "5stack",
      });

      let imageID: string | undefined;

      if (service === "hasura") {
        imageID = pod.status?.initContainerStatuses?.[0]?.imageID;
      } else {
        imageID = pod.status?.containerStatuses?.[0]?.imageID;
      }

      if (!imageID) {
        throw new Error("imageID not found");
      }

      const parts = imageID.split("@");
      if (parts.length < 2) {
        throw new Error("imageID format invalid");
      }

      return parts[1];
    } catch (error) {
      this.logger.error(`Error fetching pod info: ${error?.message || error}`);
    }
  }

  private async getToken(image: string) {
    const tokenResponse = await fetch(
      `https://ghcr.io/token?scope=repository:5stackgg/${image}:pull`,
    );
    const { token } = await tokenResponse.json();

    return token;
  }

  private getServiceCacheKey(channel: string, service: string) {
    return `version:v3:${channel}:${service}`;
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
      this.getServiceCacheKey("na", "panel"),
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
