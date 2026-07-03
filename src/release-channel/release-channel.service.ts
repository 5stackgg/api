import fetch from "node-fetch";
import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";

@Injectable()
export class ReleaseChannelService {
  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly postgres: PostgresService,
  ) {}

  public async getReleaseChannel(): Promise<"latest" | "beta"> {
    const [data] = await this.postgres.query<
      Array<{
        value: string;
      }>
    >(`SELECT value FROM public.settings WHERE name = $1 LIMIT 1`, [
      SystemSettingName.ReleaseChannel,
    ]);

    return data?.value === "beta" ? "beta" : "latest";
  }

  public async resolveChannelImage(image: string): Promise<string> {
    const channel = await this.getReleaseChannel();
    if (channel !== "beta") {
      return image;
    }

    const match = image.match(/^ghcr\.io\/5stackgg\/([^/:]+):[^:]+$/);
    if (!match) {
      return image;
    }

    const registry = match[1];
    if (!(await this.channelTagExists(registry, "beta"))) {
      return image;
    }

    return image.replace(/:[^:/]+$/, ":beta");
  }

  public async channelTagExists(
    registry: string,
    tag: string,
  ): Promise<boolean> {
    return await this.cache.remember<boolean>(
      `channel-tag:${registry}:${tag}`,
      async () => {
        try {
          const token = await this.getToken(registry);
          const response = await fetch(
            `https://ghcr.io/v2/5stackgg/${registry}/manifests/${tag}`,
            {
              method: "HEAD",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.oci.image.index.v1+json",
              },
            },
          );
          return response.ok;
        } catch (error) {
          this.logger.warn(
            `Unable to check channel tag ${registry}:${tag}`,
            error,
          );
          return false;
        }
      },
      300,
    );
  }

  private async getToken(image: string) {
    const tokenResponse = await fetch(
      `https://ghcr.io/token?scope=repository:5stackgg/${image}:pull`,
    );
    const { token } = await tokenResponse.json();

    return token;
  }
}
