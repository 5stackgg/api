import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import AdmZip from "adm-zip";
import { Readable } from "stream";
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

// A HUD bundle is a web app, not a media file: a few hundred KB of JS, CSS and
// images. The cap is generous against that and still small enough that holding
// one in memory to inspect it is unremarkable.
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

// Inlined into the row as a data URL, so it rides every listing query. Anything
// larger than this is a bundle shipping a poster instead of a thumbnail.
const MAX_THUMBNAIL_BYTES = 512 * 1024;

// Mac zips carry these; JTs Hud Manager ignores them on extract and so must the
// validation, or a bundle zipped on a Mac is rejected for files its author
// never added.
const ARCHIVE_JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\._)/;

@Injectable()
export class BroadcastHudsService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
  ) {}

  // Which HUD the pod should boot. Falls back through the legacy setting so an
  // instance that never opens the new page keeps exactly the layout it had:
  // default_hud_mode named a *variant* of the one bundled HUD, which is now the
  // pair of seeded builtin rows.
  public async resolveDefault(): Promise<BroadcastHud | null> {
    const [preferred] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.DefaultBroadcastHud],
    );

    if (preferred?.value) {
      const hud = await this.bySlug(preferred.value);
      if (hud?.enabled) {
        return hud;
      }
      // Not an error worth failing a stream over -- a HUD can be deleted or
      // disabled while it is still named as the default.
      this.logger.warn(
        `default broadcast hud "${preferred.value}" is missing or disabled — falling back`,
      );
    }

    const [legacy] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.DefaultHudMode],
    );

    const variant = legacy?.value === "vertical" ? "vertical" : "horizontal";
    return await this.bySlug(`default-${variant}`);
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

  // The archive is served whole; JTs Hud Manager inside the pod does the
  // extracting. See import() for why we still read it here.
  public async bundle(
    slug: string,
  ): Promise<{ stream: Readable; size: number } | null> {
    const hud = await this.bySlug(slug);
    if (!hud || !hud.enabled || !hud.storage_key) {
      return null;
    }
    return {
      stream: await this.s3.get(hud.storage_key),
      size: Number(hud.size_bytes ?? 0),
    };
  }

  public async import(
    archive: Buffer,
    originalName: string,
    uploadedBySteamId?: string,
  ): Promise<BroadcastHud> {
    const parsed = this.inspect(archive, originalName);

    const slug = await this.availableSlug(parsed.suggestedSlug);
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
          parsed.jthudId,
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
      // The object is written before the row so a successful insert can never
      // point at nothing. If the insert is what failed, take the object back
      // out rather than leaving an orphan for the s3 sweeper to puzzle over.
      await this.s3.remove(storageKey).catch(() => {
        // Nothing useful to do about a failed cleanup here -- the insert error
        // below is the one the caller needs.
      });
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

    if (hud.storage_key) {
      await this.s3.remove(hud.storage_key).catch((error) => {
        // The row is gone, so the HUD is gone as far as everything else is
        // concerned; a stranded object is a storage cost, not a correctness bug.
        this.logger.warn(
          `removed broadcast hud ${slug} but its object survived: ${
            (error as Error)?.message ?? error
          }`,
        );
      });
    }
  }

  // Read the archive well enough to describe it, and refuse the shapes JTs Hud
  // Manager would mishandle.
  //
  // This is the only archive handling on our side -- we do not extract. It
  // exists because JTHud's own upload-zip writes entries with
  // `path.join(hudDir, relativePath)` and no traversal guard, and takes the
  // hud id straight from the archive when hud.json sits one level deep. The
  // panel is the only thing that ever uploads to it, so the panel is where a
  // hostile archive has to be stopped.
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

    // The same rule JTHud applies, so what we accept is exactly what it can
    // install: hud.json at the root, or inside a single top-level folder.
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

    const nested = manifest.entryName !== "hud.json";
    const prefix = nested
      ? manifest.entryName.replace(/\/hud\.json$/, "") + "/"
      : "";

    // Mirror of JTHud's own derivation, so the id we record is the id it will
    // create. Nested wins because that branch ignores the filename entirely.
    const jthudId = nested
      ? prefix.slice(0, -1)
      : originalName
          .replace(/\.zip$/i, "")
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .toLowerCase();

    if (!/^[A-Za-z0-9_-]+$/.test(jthudId)) {
      throw new BadRequestException(
        `"${jthudId}" cannot be used as a HUD id — rename the folder inside the archive`,
      );
    }

    const isSigned = entries.some(
      (entry) =>
        !entry.isDirectory &&
        (entry.entryName === "key" || entry.entryName === prefix + "key"),
    );

    // A signed bundle's hud.json is a signature envelope rather than plain
    // JSON. We do not verify it -- JTHud does that on install, against the key
    // beside it -- so failing to parse is expected here, not an error.
    let hudJson: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(manifest.getData().toString("utf-8")) as unknown;
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

    const name = text("name") ?? jthudId;

    return {
      jthudId,
      name,
      author: text("author"),
      version: text("version"),
      description: text("description"),
      isSigned,
      hudJson,
      thumbnail: this.readThumbnail(entries, prefix),
      suggestedSlug: this.slugify(name),
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

  // The slug is unique and lands in a URL, so a second import of a HUD by the
  // same name gets a suffix rather than an error the operator has to resolve by
  // renaming a file.
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
