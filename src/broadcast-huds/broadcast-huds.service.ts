import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import AdmZip from "adm-zip";
import { PostgresService } from "src/postgres/postgres.service";
import { S3Service } from "src/s3/s3.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";

export type BroadcastHud = {
  id: string;
  slug: string;
  jthud_id: string;
  variant: string | null;
  name: string;
  author: string | null;
  version: string | null;
  description: string | null;
  source: "builtin" | "imported";
  enabled: boolean;
  storage_key: string | null;
  size_bytes: string | null;
  is_signed: boolean;
};

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const MAX_THUMBNAIL_BYTES = 512 * 1024;

const BUNDLE_URL_TTL_SECONDS = 60 * 60;

// JTs Hud Manager skips these on extract, so a bundle zipped on a Mac must not
// be rejected for them.
const ARCHIVE_JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\._)/;

@Injectable()
export class BroadcastHudsService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
  ) {}

  public async resolveDefault(): Promise<BroadcastHud | null> {
    const preferred = await this.getSetting(
      SystemSettingName.DefaultBroadcastHud,
    );

    if (preferred) {
      const hud = await this.bySlug(preferred);
      if (hud?.enabled) {
        return hud;
      }
      this.logger.warn(
        `default broadcast hud "${preferred}" is missing or disabled, falling back`,
      );
    }

    const legacy = await this.getSetting(SystemSettingName.DefaultHudMode);

    return await this.bySlug(
      legacy === "vertical" ? "default-vertical" : "default-horizontal",
    );
  }

  public async resolveEnabled(slug: string): Promise<BroadcastHud> {
    const hud = await this.bySlug(BroadcastHudsService.normalizeSlug(slug));

    if (!hud || !hud.enabled) {
      throw new Error(`no enabled broadcast hud named "${slug}"`);
    }

    return hud;
  }

  public async bySlug(slug: string): Promise<BroadcastHud | null> {
    const [hud] = await this.postgres.query<Array<BroadcastHud>>(
      `SELECT id, slug, jthud_id, variant, name, author, version, description,
              source, enabled, storage_key, size_bytes, is_signed
         FROM public.broadcast_huds
        WHERE slug = $1
        LIMIT 1`,
      [slug],
    );
    return hud ?? null;
  }

  public async bundleUrl(hud: BroadcastHud): Promise<string | null> {
    if (!hud.storage_key) {
      return null;
    }

    return await this.s3.getPresignedUrl(
      hud.storage_key,
      undefined,
      BUNDLE_URL_TTL_SECONDS,
      "get",
    );
  }

  public async import(
    archive: Buffer,
    originalName: string,
    uploadedBySteamId?: string,
  ): Promise<BroadcastHud> {
    const parsed = this.inspect(archive, originalName);

    const slug = await this.availableSlug(this.slugify(parsed.name));
    const storageKey = `broadcast-huds/${slug}.zip`;

    await this.s3.put(storageKey, archive, "application/zip");

    try {
      const [hud] = await this.postgres.query<Array<BroadcastHud>>(
        `INSERT INTO public.broadcast_huds
           (slug, jthud_id, variant, name, author, version, description,
            source, storage_key, size_bytes, thumbnail, hud_json, is_signed,
            uploaded_by_steam_id)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'imported', $7, $8, $9, $10, $11, $12)
         RETURNING id, slug, jthud_id, variant, name, author, version,
                   description, source, enabled, storage_key, size_bytes,
                   is_signed`,
        [
          slug,
          parsed.folder ?? slug,
          parsed.name,
          parsed.author,
          parsed.version,
          parsed.description,
          storageKey,
          archive.length,
          parsed.thumbnail,
          parsed.hudJson ? JSON.stringify(parsed.hudJson) : null,
          parsed.isSigned,
          uploadedBySteamId ?? null,
        ],
      );
      return hud;
    } catch (error) {
      await this.s3.remove(storageKey);
      throw error;
    }
  }

  public async remove(slug: string): Promise<void> {
    const hud = await this.bySlug(slug);
    if (!hud) {
      throw new BadRequestException("no such hud");
    }
    if (hud.source === "builtin") {
      throw new BadRequestException(
        "built-in HUDs ship inside the game-streamer image and can only be disabled",
      );
    }

    await this.postgres.query(
      `DELETE FROM public.broadcast_huds WHERE slug = $1`,
      [slug],
    );

    if (hud.storage_key && !(await this.s3.remove(hud.storage_key))) {
      this.logger.warn(
        `removed broadcast hud ${slug} but could not delete ${hud.storage_key}`,
      );
    }
  }

  private static normalizeSlug(slug: string): string {
    if (slug === "vertical") {
      return "default-vertical";
    }
    if (slug === "horizontal" || slug === "default") {
      return "default-horizontal";
    }
    return slug;
  }

  private async getSetting(name: SystemSettingName): Promise<string | null> {
    const [setting] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [name],
    );
    return setting?.value || null;
  }

  // JTs Hud Manager's upload-zip extracts with no traversal guard, and the pod
  // hands it whatever we stored, so hostile archives have to be refused here.
  private inspect(archive: Buffer, originalName: string) {
    if (archive.length === 0) {
      throw new BadRequestException("the uploaded file is empty");
    }
    if (archive.length > MAX_ARCHIVE_BYTES) {
      throw new BadRequestException(
        `HUD bundles are limited to ${Math.floor(
          MAX_ARCHIVE_BYTES / (1024 * 1024),
        )}MB`,
      );
    }

    let zip: AdmZip;
    try {
      zip = new AdmZip(archive);
    } catch {
      throw new BadRequestException("that file is not a readable zip archive");
    }

    const entries = zip
      .getEntries()
      .filter((entry) => !ARCHIVE_JUNK.test(entry.entryName));

    if (entries.length === 0) {
      throw new BadRequestException("the archive is empty");
    }

    for (const entry of entries) {
      const name = entry.entryName;
      if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
        throw new BadRequestException(
          `the archive contains an absolute path (${name})`,
        );
      }
      if (name.split("/").includes("..")) {
        throw new BadRequestException(
          `the archive contains a path that escapes it (${name})`,
        );
      }
    }

    const manifest = entries.find(
      (entry) =>
        !entry.isDirectory &&
        (entry.entryName === "hud.json" ||
          /^[^/]+\/hud\.json$/.test(entry.entryName)),
    );
    if (!manifest) {
      throw new BadRequestException(
        "no hud.json found — it must sit at the archive root or inside a single top-level folder",
      );
    }

    // JTs Hud Manager installs a nested bundle under its folder name, and a
    // root-level one under the posted filename, which the pod sends as <slug>.zip.
    const folder =
      manifest.entryName === "hud.json"
        ? null
        : manifest.entryName.replace(/\/hud\.json$/, "");
    const prefix = folder ? `${folder}/` : "";

    if (folder && !/^[A-Za-z0-9_-]+$/.test(folder)) {
      throw new BadRequestException(
        `"${folder}" cannot be used as a HUD id — rename the folder inside the archive`,
      );
    }

    const isSigned = entries.some(
      (entry) =>
        !entry.isDirectory &&
        (entry.entryName === "key" || entry.entryName === `${prefix}key`),
    );

    // A signed bundle's hud.json is a signature envelope, not JSON.
    let hudJson: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(
        manifest.getData().toString("utf-8"),
      ) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        hudJson = parsed as Record<string, unknown>;
      }
    } catch {
      hudJson = null;
    }

    const text = (key: string): string | null => {
      const value = hudJson?.[key];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    };

    return {
      folder,
      name: text("name") ?? folder ?? originalName.replace(/\.zip$/i, ""),
      author: text("author"),
      version: text("version"),
      description: text("description"),
      isSigned,
      hudJson,
      thumbnail: this.readThumbnail(entries, prefix),
    };
  }

  private readThumbnail(
    entries: Array<AdmZip.IZipEntry>,
    prefix: string,
  ): string | null {
    const candidates: Array<[string, string]> = [
      [`${prefix}thumb.png`, "image/png"],
      [`${prefix}thumb.jpg`, "image/jpeg"],
      [`${prefix}thumb.jpeg`, "image/jpeg"],
    ];

    for (const [path, contentType] of candidates) {
      const entry = entries.find(
        (candidate) => !candidate.isDirectory && candidate.entryName === path,
      );
      if (!entry) {
        continue;
      }
      const data = entry.getData();
      if (data.length === 0 || data.length > MAX_THUMBNAIL_BYTES) {
        continue;
      }
      return `data:${contentType};base64,${data.toString("base64")}`;
    }

    return null;
  }

  private slugify(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "hud";
  }

  private async availableSlug(base: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const [existing] = await this.postgres.query<Array<{ slug: string }>>(
        `SELECT slug FROM public.broadcast_huds WHERE slug = $1 LIMIT 1`,
        [candidate],
      );
      if (!existing) {
        return candidate;
      }
    }
    throw new BadRequestException(
      `too many HUDs already named "${base}" — give this one a different name`,
    );
  }
}
