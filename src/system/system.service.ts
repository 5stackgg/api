import fetch from "node-fetch";
import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { HasuraService } from "src/hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { TailscaleConfig } from "src/configs/types/TailscaleConfig";
import { DiscordConfig } from "src/configs/types/DiscordConfig";
import { Colors } from "discord.js";

@Injectable()
export class SystemService {
  private apiClient: CoreV1Api;

  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.apiClient = kc.makeApiClient(CoreV1Api);
  }

  public async detectFeatures() {
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
            name: "supports_game_server_nodes",
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
            name: "public.supports_discord_bot",
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
  }

  public async updateServices() {
    const services = await this.getServices();
    const latestVersions = await this.getLatestVersions();

    for (const { pod, service, version } of Object.values(services)) {
      if (version === latestVersions[service]) {
        continue;
      }

      await this.restartPod(pod);
      await this.cache.forget(this.getServiceCacheKey(service));
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

    const services = await this.getServices();
    const latestVersions = await this.getLatestVersions();

    for (const { service, version, pod } of Object.values(services)) {
      const latestVersion = latestVersions[service];
      if (version !== latestVersion) {
        hasUpdates.push({
          service,
          pod,
          currentVersion: version,
          newVersion: latestVersion,
        });
      }
    }

    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: "updates",
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

  public async getLatestVersions(): Promise<Record<string, string>> {
    const registries = ["api", "web", "game-server-node"];
    const latestVersions: Record<string, string> = {};

    for (const registry of registries) {
      const data = await this.cache.remember<{
        service: string;
        latestVersion: string;
      }>(
        this.getServiceCacheKey(registry),
        async () => {
          const token = await this.getToken(registry);
          const latestManifestResponse = await fetch(
            `https://ghcr.io/v2/5stackgg/${registry}/manifests/latest`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.oci.image.index.v1+json",
              },
            },
          );

          if (!latestManifestResponse.ok) {
            throw new Error(
              `Failed to fetch manifest [${registry}]: ${latestManifestResponse.statusText}`,
            );
          }

          return {
            service: registry,
            latestVersion: latestManifestResponse.headers.get(
              "docker-content-digest",
            ),
          };
        },
        300,
      );

      latestVersions[data.service] = data.latestVersion;
    }

    latestVersions.hasura = latestVersions.api;

    return latestVersions;
  }

  public async restartPod(pod: string) {
    await this.apiClient.deleteNamespacedPod(pod, "5stack");
  }

  public async getServices() {
    const { body } = await this.apiClient.listNamespacedPod("5stack");

    const pods = body.items.filter((pod) => {
      if (pod.metadata.labels.codepier) {
        return false;
      }

      return ["api", "web", "game-server-node-connector", "hasura"].includes(
        pod.metadata.labels.app,
      );
    });

    const services: Array<{ pod: string; service: string; version: string }> =
      [];

    for (const pod of pods) {
      const service = pod.metadata.labels.app;
      services.push({
        pod: pod.metadata.name,
        service:
          service === "game-server-node-connector"
            ? "game-server-node"
            : service,
        version: await this.getServiceVersion(service, pod.metadata.name),
      });
    }

    return services;
  }

  private async getServiceVersion(service: string, podName: string) {
    try {
      const { body } = await this.apiClient.readNamespacedPod(
        podName,
        "5stack",
      );

      return (
        service === "hasura"
          ? body.status.initContainerStatuses.at(0).imageID
          : body.status.containerStatuses.at(0).imageID
      )
        .split("@")
        .at(1);
    } catch (error) {
      console.error(`Error fetching pod info: ${error.message}`);
    }
  }

  private async getToken(image: string) {
    const tokenResponse = await fetch(
      `https://ghcr.io/token?scope=repository:5stackgg/${image}:pull`,
    );
    const { token } = await tokenResponse.json();

    return token;
  }

  private getServiceCacheKey(service: string) {
    return `version:${service}`;
  }

  private async getPanelVersion() {
    try {
      const { body } = await this.apiClient.listNode(
        undefined,
        undefined,
        undefined,
        undefined,
        "node-role.kubernetes.io/control-plane",
      );

      return body.items.at(0)?.metadata.labels["5stack-panel-version"];
    } catch (error) {
      this.logger.warn("unable to fetch panel version", error);
      return "";
    }
  }

  private async getLatestPanelVersion() {
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
  }
}
