import { Injectable, Logger } from "@nestjs/common";
import sharp from "sharp";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";

const PWA_ICON_SIZES = [192, 512] as const;
const PWA_ICON_BACKGROUND = { r: 10, g: 10, b: 14, alpha: 1 };

@Injectable()
export class BrandingService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
  ) {}

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

  async uploadAppIcon(buffer: Buffer): Promise<void> {
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

    const logo = await sharp(buffer)
      .resize(512, 512, {
        fit: "inside",
        withoutEnlargement: true,
        background: transparent,
      })
      .png()
      .toBuffer();
    await this.s3.put("branding/logo.png", logo);
    await this.upsertSetting("public.logo_url", "branding/logo.png");

    const favicon = await sharp(buffer)
      .resize(64, 64, { fit: "contain", background: transparent })
      .png()
      .toBuffer();
    await this.s3.put("branding/favicon.png", favicon);
    await this.upsertSetting("public.favicon_url", "branding/favicon.png");

    for (const size of PWA_ICON_SIZES) {
      const png = await this.renderPwaIcon(buffer, size);
      await this.s3.put(`branding/pwa-${size}.png`, png);
    }
    await this.upsertSetting("public.pwa_icon", `${Date.now()}`);

    this.logger.log("Generated app icon (logo, favicon, PWA icons)");
  }

  async getPwaIcon(size: number) {
    if (!PWA_ICON_SIZES.includes(size as (typeof PWA_ICON_SIZES)[number])) {
      return null;
    }

    const filePath = `branding/pwa-${size}.png`;
    if (!(await this.s3.has(filePath))) {
      return null;
    }

    return {
      stream: await this.s3.get(filePath),
      contentType: "image/png",
    };
  }

  private async renderPwaIcon(buffer: Buffer, size: number): Promise<Buffer> {
    const inner = Math.round(size * 0.8);
    const logo = await sharp(buffer)
      .resize(inner, inner, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    return sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: PWA_ICON_BACKGROUND,
      },
    })
      .composite([{ input: logo, gravity: "center" }])
      .png()
      .toBuffer();
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

  async deleteFile(
    type: "logo" | "favicon" | "pwa" | "icon",
  ): Promise<boolean> {
    if (type === "icon") {
      await this.deleteFile("logo");
      await this.deleteFile("favicon");
      await this.deleteFile("pwa");
      return true;
    }

    if (type === "pwa") {
      for (const size of PWA_ICON_SIZES) {
        const filePath = `branding/pwa-${size}.png`;
        if (await this.s3.has(filePath)) {
          await this.s3.remove(filePath);
        }
      }
      await this.deleteSetting("public.pwa_icon");
      this.logger.log("Deleted PWA icons");
      return true;
    }

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
