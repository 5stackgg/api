import { Injectable, Logger } from "@nestjs/common";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";

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
      contentType: stat.metaData?.["content-type"] || this.guessContentType(filePath),
      etag: stat.etag,
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
