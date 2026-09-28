import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import AdmZip from "adm-zip";
import dns from "dns";
import https from "https";
import { BlockList, isIP, LookupFunction } from "net";
import sharp from "sharp";
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
  page_url: string | null;
};

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const MAX_THUMBNAIL_BYTES = 512 * 1024;

const MAX_PREVIEW_BYTES = 512 * 1024;

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 10_000;

const MAX_REDIRECTS = 3;

const BUNDLE_URL_TTL_SECONDS = 60 * 60;

// JTs Hud Manager skips these on extract, so a bundle zipped on a Mac must not
// be rejected for them.
const ARCHIVE_JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\._)/;

const HUD_COLUMNS = `id, slug, jthud_id, variant, name, author, version, description,
  source, enabled, storage_key, size_bytes, is_signed, page_url`;

// The api runs inside the cluster, so a page link must never be able to reach
// a private or cluster-internal address.
const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

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
      `SELECT ${HUD_COLUMNS}
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
    const preview = parsed.screenshot
      ? await this.renderPreview(parsed.screenshot).catch((): null => null)
      : null;

    const slug = await this.availableSlug(this.slugify(parsed.name));
    const storageKey = `broadcast-huds/${slug}.zip`;

    await this.s3.put(storageKey, archive, "application/zip");

    try {
      const [hud] = await this.postgres.query<Array<BroadcastHud>>(
        `INSERT INTO public.broadcast_huds
           (slug, jthud_id, variant, name, author, version, description,
            source, storage_key, size_bytes, thumbnail, hud_json, is_signed,
            uploaded_by_steam_id, preview)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'imported', $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${HUD_COLUMNS}`,
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
          preview,
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

  public async setPage(
    slug: string,
    pageUrl: string | null,
  ): Promise<{ hud: BroadcastHud; previewUpdated: boolean }> {
    if (!(await this.bySlug(slug))) {
      throw new BadRequestException("no such hud");
    }

    const trimmed = pageUrl?.trim();
    if (!trimmed) {
      const [hud] = await this.postgres.query<Array<BroadcastHud>>(
        `UPDATE public.broadcast_huds SET page_url = NULL
          WHERE slug = $1
          RETURNING ${HUD_COLUMNS}`,
        [slug],
      );
      return { hud, previewUpdated: false };
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new BadRequestException("that is not a valid link");
    }

    const page = await this.fetchPublic(url, MAX_PAGE_BYTES);
    const imageUrl = page.contentType.startsWith("image/")
      ? null
      : BroadcastHudsService.previewImageUrl(
          page.body.toString("utf-8"),
          page.url,
        );

    let preview: string | null = null;
    if (page.contentType.startsWith("image/")) {
      preview = await this.renderPreview(page.body);
    } else if (imageUrl) {
      const image = await this.fetchPublic(imageUrl, MAX_IMAGE_BYTES);
      preview = await this.renderPreview(image.body);
    }

    const [hud] = await this.postgres.query<Array<BroadcastHud>>(
      `UPDATE public.broadcast_huds
          SET page_url = $2, preview = COALESCE($3, preview)
        WHERE slug = $1
        RETURNING ${HUD_COLUMNS}`,
      [slug, url.toString(), preview],
    );

    return { hud, previewUpdated: preview !== null };
  }

  private static previewImageUrl(html: string, base: URL): URL | null {
    const found = new Map<string, string>();
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i
        .exec(tag)?.[1]
        ?.toLowerCase();
      const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (key && content && !found.has(key)) {
        found.set(key, content.replace(/&amp;/g, "&").trim());
      }
    }

    for (const key of [
      "og:image:secure_url",
      "og:image",
      "og:image:url",
      "twitter:image",
      "twitter:image:src",
    ]) {
      const value = found.get(key);
      if (!value) {
        continue;
      }
      try {
        return new URL(value, base);
      } catch {
        continue;
      }
    }

    return null;
  }

  private async renderPreview(image: Buffer): Promise<string> {
    let webp: Buffer;
    try {
      webp = await sharp(image, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize(1280, 720, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      throw new BadRequestException("the preview is not a readable image");
    }

    if (webp.length > MAX_PREVIEW_BYTES) {
      throw new BadRequestException("the preview image is too large");
    }

    return `data:image/webp;base64,${webp.toString("base64")}`;
  }

  private static isPrivateAddress(address: string): boolean {
    return PRIVATE_ADDRESSES.check(
      address,
      isIP(address) === 6 ? "ipv6" : "ipv4",
    );
  }

  // Checked at connect time rather than before the request, so a hostname
  // cannot resolve to a public address for the check and a private one after.
  private static readonly publicLookup: LookupFunction = (
    hostname,
    options,
    callback,
  ) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 4);
        return;
      }
      const list = addresses as Array<dns.LookupAddress>;
      if (
        list.length === 0 ||
        list.some(({ address }) =>
          BroadcastHudsService.isPrivateAddress(address),
        )
      ) {
        callback(
          new BadRequestException(`${hostname} is not a public address`),
          "",
          4,
        );
        return;
      }
      if (options.all) {
        (
          callback as unknown as (
            error: null,
            addresses: Array<dns.LookupAddress>,
          ) => void
        )(null, list);
        return;
      }
      callback(null, list[0].address, list[0].family);
    });
  };

  private fetchPublic(
    url: URL,
    maxBytes: number,
    redirects = MAX_REDIRECTS,
  ): Promise<{ body: Buffer; contentType: string; url: URL }> {
    return new Promise((resolve, reject) => {
      if (url.protocol !== "https:") {
        reject(new BadRequestException("links must use https"));
        return;
      }
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) && BroadcastHudsService.isPrivateAddress(literal)) {
        reject(new BadRequestException(`${url.host} is not a public address`));
        return;
      }

      const request = https.get(
        url,
        {
          lookup: BroadcastHudsService.publicLookup,
          timeout: FETCH_TIMEOUT_MS,
          headers: { "user-agent": "5stack-broadcast-huds" },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;

          if (status >= 300 && status < 400 && location) {
            response.resume();
            if (redirects === 0) {
              reject(new BadRequestException("the link redirects too often"));
              return;
            }
            resolve(
              this.fetchPublic(new URL(location, url), maxBytes, redirects - 1),
            );
            return;
          }

          if (status !== 200) {
            response.resume();
            reject(new BadRequestException(`${url.host} answered ${status}`));
            return;
          }

          const chunks: Array<Buffer> = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              request.destroy();
              reject(new BadRequestException(`${url.host} sent too much data`));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            resolve({
              body: Buffer.concat(chunks),
              contentType: String(response.headers["content-type"] ?? ""),
              url,
            });
          });
          response.on("error", reject);
        },
      );

      request.on("timeout", () => {
        request.destroy(new Error("timed out"));
      });
      request.on("error", (error) => {
        reject(
          error instanceof BadRequestException
            ? error
            : new BadRequestException(
                `could not reach ${url.host}: ${error.message}`,
              ),
        );
      });
    });
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
      screenshot: this.readScreenshot(entries, prefix),
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

  private readScreenshot(
    entries: Array<AdmZip.IZipEntry>,
    prefix: string,
  ): Buffer | null {
    const entry = entries.find(
      (candidate) =>
        !candidate.isDirectory &&
        candidate.entryName.startsWith(prefix) &&
        /^(preview|screenshot)\.(png|jpe?g|webp)$/i.test(
          candidate.entryName.slice(prefix.length),
        ),
    );
    if (!entry || entry.header.size > MAX_IMAGE_BYTES) {
      return null;
    }
    return entry.getData();
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
