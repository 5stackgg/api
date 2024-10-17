import fetch from "node-fetch";
import { Injectable } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { HasuraService } from "src/hasura/hasura.service";

@Injectable()
export class SystemService {
  private apiClient: CoreV1Api;

  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.apiClient = kc.makeApiClient(CoreV1Api);
  }

  public async updateServices() {
    const services = await this.getServices();
    const latestVersions = await this.getLatestVersions();

    for (const { service, version, pod } of services) {
      if (version === latestVersions[service]) {
        continue;
      }

      await this.restartPod(pod);
      await this.cache.forget(this.getServiceCacheKey(service));
    }
  }

  public async setVersions() {
    const services = await this.getServices();
    const latestVersions = await this.getLatestVersions();

    for (const { service, version, pod } of services) {
      await this.hasura.mutation({
        insert_settings_one: {
          __args: {
            object: {
              name: service,
              value: JSON.stringify({
                current: version,
                latest: latestVersions[service],
              }),
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

    return latestVersions;
  }

  public async restartPod(pod: string) {
    await this.apiClient.deleteNamespacedPod(pod, "5stack");
  }

  public async getServices() {
    const { body } = await this.apiClient.listNamespacedPod("5stack");

    const services = body.items.filter((pod) => {
      if (pod.metadata.labels.codepier) {
        return false;
      }

      return ["api", "web", "game-server-node-connector"].includes(
        pod.metadata.labels.app,
      );
    });

    return Promise.all(
      services.map(async (pod) => {
        return {
          pod: pod.metadata.name,
          service:
            pod.metadata.labels.app === "game-server-node-connector"
              ? "game-server-node"
              : pod.metadata.labels.app,
          version: await this.getServiceVersion(pod.metadata.name),
        };
      }),
    );
  }

  private async getServiceVersion(podName: string) {
    try {
      const { body } = await this.apiClient.readNamespacedPod(
        podName,
        "5stack",
      );
      const imageID = body.status.containerStatuses[0].imageID;
      return imageID.split("@")[1];
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
}
