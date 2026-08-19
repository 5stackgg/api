import crypto from "crypto";
import { Readable } from "stream";
import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";
import { S3Service } from "src/s3/s3.service";
import { NotificationsService } from "src/notifications/notifications.service";

export interface NewsPostRow {
  id: string;
  slug: string;
  title: string;
  teaser: string | null;
  cover_image_url: string | null;
  content_markdown: string;
  status: string;
  author_steam_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  view_count: string;
}

export interface SaveNewsPostInput {
  id?: string | null;
  title: string;
  teaser?: string | null;
  cover_image_url?: string | null;
  content_markdown: string;
}

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
};

@Injectable()
export class NewsService {
  private static readonly IMAGE_PREFIX = "news";

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
    private readonly notifications: NotificationsService,
  ) {}

  private async announcePublished(article: NewsPostRow): Promise<void> {
    await this.notifications.notifyActivePlayers("NewsPublished", {
      title: "New article",
      message: `<a href="/news/${article.slug}"><b>${NotificationsService.escapeHtml(
        article.title,
      )}</b></a> was just published.`,
      entity_id: article.id,
      ...(article.cover_image_url
        ? { data: { image: article.cover_image_url } }
        : {}),
    });
  }

  public async listPosts(limit = 200): Promise<NewsPostRow[]> {
    return await this.postgres.query<NewsPostRow[]>(
      `SELECT * FROM public.news_articles ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
  }

  public async getPost(id: string): Promise<NewsPostRow | null> {
    const [row] = await this.postgres.query<NewsPostRow[]>(
      `SELECT * FROM public.news_articles WHERE id = $1 LIMIT 1`,
      [id],
    );
    return row ?? null;
  }

  public async savePost(
    input: SaveNewsPostInput,
    authorSteamId: string,
  ): Promise<NewsPostRow> {
    const title = input.title?.trim();
    if (!title) {
      throw new BadRequestException("A title is required");
    }

    const teaser = input.teaser?.trim() || null;
    const coverImageUrl = input.cover_image_url?.trim() || null;
    const contentMarkdown = input.content_markdown ?? "";

    if (input.id) {
      const [current] = await this.postgres.query<
        Array<{ title: string; slug: string; status: string }>
      >(`SELECT title, slug, status FROM public.news_articles WHERE id = $1`, [
        input.id,
      ]);
      if (!current) {
        throw new BadRequestException("News post not found");
      }

      const slugChanged =
        current.status !== "published" &&
        this.slugify(title) !== this.slugify(current.title);

      if (!slugChanged) {
        const [row] = await this.postgres.query<NewsPostRow[]>(
          `UPDATE public.news_articles
             SET title = $2, teaser = $3, cover_image_url = $4, content_markdown = $5, updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [input.id, title, teaser, coverImageUrl, contentMarkdown],
        );
        return row;
      }

      const baseSlug = this.slugify(title);
      for (let attempt = 0; attempt < 5; attempt++) {
        const slug =
          attempt === 0
            ? baseSlug
            : `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
        try {
          const [row] = await this.postgres.query<NewsPostRow[]>(
            `UPDATE public.news_articles
               SET title = $2, teaser = $3, cover_image_url = $4, content_markdown = $5, slug = $6, updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [input.id, title, teaser, coverImageUrl, contentMarkdown, slug],
          );
          return row;
        } catch (error) {
          if (this.isSlugConflict(error) && attempt < 4) {
            continue;
          }
          throw error;
        }
      }

      throw new BadRequestException("Could not generate a unique slug");
    }

    const baseSlug = this.slugify(title);

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug =
        attempt === 0
          ? baseSlug
          : `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
      try {
        const [row] = await this.postgres.query<NewsPostRow[]>(
          `INSERT INTO public.news_articles
            (slug, title, teaser, cover_image_url, content_markdown, status, author_steam_id)
           VALUES ($1, $2, $3, $4, $5, 'draft', $6)
           RETURNING *`,
          [slug, title, teaser, coverImageUrl, contentMarkdown, authorSteamId],
        );
        return row;
      } catch (error) {
        if (this.isSlugConflict(error) && attempt < 4) {
          continue;
        }
        throw error;
      }
    }

    throw new BadRequestException("Could not generate a unique slug");
  }

  public async setStatus(id: string, status: string): Promise<NewsPostRow> {
    if (status !== "draft" && status !== "published") {
      throw new BadRequestException("Status must be 'draft' or 'published'");
    }

    if (status === "draft") {
      const [row] = await this.postgres.query<NewsPostRow[]>(
        `UPDATE public.news_articles
           SET status = 'draft', updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id],
      );
      if (!row) {
        throw new BadRequestException("News post not found");
      }
      return row;
    }

    const [current] = await this.postgres.query<
      Array<{ title: string; status: string }>
    >(`SELECT title, status FROM public.news_articles WHERE id = $1`, [id]);
    if (!current) {
      throw new BadRequestException("News post not found");
    }

    // Only a real draft -> published transition announces. Without this, every
    // subsequent save of a published article re-notifies everyone.
    const isFirstPublish = current.status !== "published";

    const baseSlug = this.slugify(current.title);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug =
        attempt === 0
          ? baseSlug
          : `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
      try {
        const [row] = await this.postgres.query<NewsPostRow[]>(
          `UPDATE public.news_articles
             SET status = 'published',
                 slug = $2,
                 published_at = CASE
                   WHEN published_at IS NULL THEN now()
                   ELSE published_at
                 END,
                 updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [id, slug],
        );

        if (isFirstPublish) {
          void this.announcePublished(row).catch((error) => {
            this.logger.warn(
              `unable to announce published article ${id}`,
              error,
            );
          });
        }

        return row;
      } catch (error) {
        if (this.isSlugConflict(error) && attempt < 4) {
          continue;
        }
        throw error;
      }
    }

    throw new BadRequestException("Could not generate a unique slug");
  }

  public async trackView(slug: string): Promise<void> {
    await this.postgres.query(
      `UPDATE public.news_articles
         SET view_count = view_count + 1
       WHERE slug = $1 AND status = 'published'`,
      [slug],
    );
  }

  public async deletePost(id: string): Promise<void> {
    await this.postgres.query(
      `DELETE FROM public.news_articles WHERE id = $1`,
      [id],
    );
  }

  public generateFilename(extension: string): string {
    return `${crypto.randomBytes(12).toString("hex")}.${extension}`;
  }

  public mediaKey(filename: string): string {
    return `${NewsService.IMAGE_PREFIX}/${filename}`;
  }

  // Keys handed back by the client on multipart complete/abort are untrusted:
  // pin them to the news prefix and the exact shape generateFilename produces
  // so a caller can never point the assembler at somebody else's object.
  public assertMediaKey(key: string | undefined, extension: string): string {
    const expected = new RegExp(
      `^${NewsService.IMAGE_PREFIX}/[0-9a-f]{24}\\.${extension}$`,
    );
    if (!key || !expected.test(key)) {
      throw new BadRequestException("invalid upload key");
    }
    return key;
  }

  public async uploadImage(buffer: Buffer, mimetype: string): Promise<string> {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const filename = this.generateFilename(ext);
    await this.s3.put(this.mediaKey(filename), buffer, mimetype);
    this.logger.log(`Uploaded news image ${filename}`);
    return filename;
  }

  public async uploadVideo(buffer: Buffer): Promise<string> {
    const filename = this.generateFilename("mp4");
    await this.s3.put(this.mediaKey(filename), buffer, "video/mp4");
    this.logger.log(`Uploaded news video ${filename}`);
    return filename;
  }

  // Mirrors EventsService.getCloudflareWorkerUrl — when a worker is configured
  // the part PUTs must route through it (it answers the CORS preflight and
  // signs the B2 write itself) rather than using a presigned S3 URL.
  public async getCloudflareWorkerUrl(): Promise<string | null> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = 'cloudflare_worker_url' LIMIT 1`,
    );
    const value = rows.at(0)?.value?.trim();
    return value ? value.replace(/\/+$/, "") : null;
  }

  public async getImageStream(
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    const key = `${NewsService.IMAGE_PREFIX}/${filename}`;

    if (!(await this.s3.has(key))) {
      return null;
    }

    const [stream, stat] = await Promise.all([
      this.s3.get(key),
      this.s3.stat(key),
    ]);

    return {
      stream,
      contentType:
        stat.metaData?.["content-type"] || this.guessContentType(filename),
      etag: stat.etag,
    };
  }

  private slugify(title: string): string {
    return (
      title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "post"
    );
  }

  private isSlugConflict(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23505"
    );
  }

  private guessContentType(filename: string): string {
    if (filename.endsWith(".png")) {
      return "image/png";
    }
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (filename.endsWith(".webp")) {
      return "image/webp";
    }
    if (filename.endsWith(".gif")) {
      return "image/gif";
    }
    if (filename.endsWith(".mp4")) {
      return "video/mp4";
    }
    return "application/octet-stream";
  }
}
