import fetch from "node-fetch";
import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import { CoreV1Api, KubeConfig, AppsV1Api } from "@kubernetes/client-node";
import { HasuraService } from "src/hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { TailscaleConfig } from "src/configs/types/TailscaleConfig";
import { DiscordConfig } from "src/configs/types/DiscordConfig";
import { SteamConfig } from "src/configs/types/SteamConfig";

@Injectable()
export class SystemService {
  private apiClient: CoreV1Api;
  private appsClient: AppsV1Api;

  private featuresDetected = false;

  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.apiClient = kc.makeApiClient(CoreV1Api);
    this.appsClient = kc.makeApiClient(AppsV1Api);

    this.detectFeatures();
  }

  public async detectFeatures() {
    while (this.featuresDetected === false) {
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

        const steamConfig = this.config.get<SteamConfig>("steam");

        let supportsGameServerNodeVersionPinning = false;
        if (steamConfig.steamUser && steamConfig.steamPassword) {
          supportsGameServerNodeVersionPinning = true;
        }

        await this.hasura.mutation({
          insert_settings_one: {
            __args: {
              object: {
                name: "supports_game_server_version_pinning",
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
        return;
      } catch (error) {
        this.logger.warn("Error detecting features", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  public async updateServices() {
    const services = await this.getServices();
    const latestVersions = await this.getLatestVersions();

    for (const { pod, service, version } of Object.values(services)) {
      if (version === latestVersions[service]) {
        continue;
      }

      try {
        await this.restartDeployment(service);
      } catch {
        await this.restartPod(pod);
      }
      await this.cache.forget(this.getServiceCacheKey(service));
    }
  }

  public async setVersions() {
    const hasUpdates = [];

    await this.updateGameServerVersion();

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
    await this.apiClient.deleteNamespacedPod({
      name: pod,
      namespace: "5stack",
    });

    this.logger.log(`Successfully restarted pod ${pod}`);
  }

  public async restartDeployment(deploymentName: string) {
    await this.appsClient.patchNamespacedDeployment({
      name: deploymentName,
      namespace: "5stack",
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
    });

    this.logger.log(`Successfully restarted deployment ${deploymentName}`);
  }

  public async getServices() {
    let postList = await this.apiClient.listNamespacedPod({
      namespace: "5stack",
    });

    const pods = postList.items.filter((pod) => {
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

  private getServiceCacheKey(service: string) {
    return `version:${service}`;
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

  private async updateGameServerVersion() {
    await this.cache.remember<string>(
      this.getServiceCacheKey("plugin"),
      async () => {
        try {
          const response = await fetch(
            "https://api.github.com/repos/5stackgg/game-server/releases/latest",
          );
          const { tag_name } = await response.json();

          if (!tag_name) {
            this.logger.warn("no tag name found for game server plugin");
            return;
          }

          await this.hasura.mutation({
            insert_settings_one: {
              __args: {
                object: {
                  name: "plugin_version",
                  value: tag_name.replace("v", ""),
                },
                on_conflict: {
                  constraint: "settings_pkey",
                  update_columns: ["value"],
                },
              },
              __typename: true,
            },
          });
        } catch (error) {
          this.logger.warn("Unable to fetch latest game server version", error);
        }
      },
      300,
    );
  }
}
