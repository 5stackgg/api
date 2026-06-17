import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";
import { AppConfig } from "../configs/types/AppConfig";

@Injectable()
export class BrandingService {
  private appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
  }

  async uploadFile(
    type: "logo" | "favicon",
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const extension = this.getExtension(mimetype);
    const path = `branding/${type}.${extension}`;

    await this.s3.put(path, buffer);

    const settingName =
      type === "logo" ? "public.logo_url" : "public.favicon_url";

    await this.upsertSetting(settingName, path);

    this.logger.log(`Uploaded branding ${type} to ${path}`);
    return path;
  }

  async getFile(type: "logo" | "favicon") {
    const settingName =
      type === "logo" ? "public.logo_url" : "public.favicon_url";

    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name: settingName },
        value: true,
      },
    });

    if (!settings_by_pk?.value) {
      return null;
    }

    const filePath = settings_by_pk.value;

    const exists = await this.s3.has(filePath);
    if (!exists) {
      return null;
    }

    const stream = await this.s3.get(filePath);
    const stat = await this.s3.stat(filePath);

    return {
      stream,
      contentType:
        stat.metaData?.["content-type"] || this.guessContentType(filePath),
      etag: stat.etag,
    };
  }

  async getManifest() {
    const names = [
      "public.brand_name",
      "public.favicon_url",
      "public.color_dark_background",
      "public.color_dark_primary",
    ];

    const { settings } = await this.hasura.query({
      settings: {
        __args: { where: { name: { _in: names } } },
        name: true,
        value: true,
      },
    });

    const get = (name: string) =>
      (settings as Array<{ name: string; value: string }>).find(
        (s) => s.name === name,
      )?.value || null;

    const brandName = get("public.brand_name") || "5Stack";
    const faviconUrl = get("public.favicon_url");
    const backgroundColor = this.toCssColor(get("public.color_dark_background"));
    const themeColor = this.toCssColor(get("public.color_dark_primary"));

    // Icon URLs are absolute so they survive being re-served same-origin by the
    // web's Nitro manifest proxy (the manifest itself must be same-origin as the
    // page for installability, but its icons can be cross-origin).
    const faviconSrc = `${this.appConfig.apiDomain}/branding/favicon?v=${encodeURIComponent(
      faviconUrl || "",
    )}`;

    const icons = faviconUrl
      ? [
          {
            src: faviconSrc,
            sizes: "192x192 512x512",
            type: this.guessContentType(faviconUrl),
          },
          {
            src: faviconSrc,
            sizes: "any",
            type: this.guessContentType(faviconUrl),
            purpose: "any",
          },
        ]
      : [
          {
            src: `${this.appConfig.webDomain}/favicon/192.png`,
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: `${this.appConfig.webDomain}/favicon/512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
        ];

    return {
      name: brandName,
      short_name: brandName,
      icons,
      theme_color: themeColor,
      background_color: backgroundColor,
      display: "standalone",
      start_url: "/",
    };
  }

  async deleteFile(type: "logo" | "favicon"): Promise<boolean> {
    const settingName =
      type === "logo" ? "public.logo_url" : "public.favicon_url";

    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name: settingName },
        value: true,
      },
    });

    if (settings_by_pk?.value) {
      await this.s3.remove(settings_by_pk.value);
    }

    await this.deleteSetting(settingName);

    this.logger.log(`Deleted branding ${type}`);
    return true;
  }

  private async upsertSetting(name: string, value: string) {
    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: { name, value },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });
  }

  private async deleteSetting(name: string) {
    await this.hasura.mutation({
      delete_settings_by_pk: {
        __args: { name },
        __typename: true,
      },
    });
  }

  // Stored color settings are shadcn space-separated HSL components
  // (e.g. "240 10% 3.9%"). Wrap into a valid CSS color for the manifest.
  private toCssColor(value: string | null): string {
    if (!value) {
      return "#000000";
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("hsl")) {
      return trimmed;
    }
    return `hsl(${trimmed})`;
  }

  private getExtension(mimetype: string): string {
    const map: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/svg+xml": "svg",
      "image/webp": "webp",
      "image/x-icon": "ico",
    };
    return map[mimetype] || "png";
  }

  private guessContentType(filePath: string): string {
    if (filePath.endsWith(".svg")) return "image/svg+xml";
    if (filePath.endsWith(".png")) return "image/png";
    if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg"))
      return "image/jpeg";
    if (filePath.endsWith(".webp")) return "image/webp";
    if (filePath.endsWith(".ico")) return "image/x-icon";
    return "application/octet-stream";
  }
}
