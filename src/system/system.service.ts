import fetch from "node-fetch";
import { Injectable } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

@Injectable()
export class SystemService {
  private apiClient: CoreV1Api;

  constructor(private readonly cache: CacheService) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.apiClient = kc.makeApiClient(CoreV1Api);
  }

  public async getVersions() {
    const registries = ["api", "web", "game-server-node"];

    const currentVersions = await this.getCurrentVersions();

    const latestImages = await Promise.all(
      registries.map(async (registry) => {
        return await this.cache.remember(
          registry,
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

            return latestManifestResponse.headers.get("docker-content-digest");
          },
          500,
        );
      }),
    );

    return {
      latestImages,
      currentVersions,
    };
  }

  private async getCurrentVersions() {
    const { body } = await this.apiClient.listNamespacedPod("5stack");

    const services = body.items.filter((pod) => {
      return ["api", "web", "game-server-node-connector"].includes(
        pod.metadata.labels.app,
      );
    });

    return Promise.all(
      services.map(async (pod) => {
        return {
          pod: pod.metadata.name,
          service: pod.metadata.labels.app,
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
}
