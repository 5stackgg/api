import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import { createHash } from "crypto";
import { S3Service } from "../../s3/s3.service";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";
import { ClipsService } from "./clips.service";

// View counting mirrors the clip Worker (5stack-panel
// cloudflare-workers/backblaze-proxy) rule for rule, viewer key included, so a
// view counts the same whichever path serves the clip and the two share one
// per-viewer dedupe.
const VIEW_FRACTION = 0.5;
const BOT_UA =
  /bot|crawl|spider|facebookexternalhit|slack|discord|telegram|whatsapp|preview|unfurl|embed|scrape|metainspector|skype|vkshare|redditbot|pinterest|googlebot|bingbot/i;

const UTILITY_LINEUP_FILE =
  /^clips\/utility\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/.].*)?\.(mp4|jpg|webp|json)$/i;
const UTILITY_LINEUP_FILE_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
};
// A lineup's files are keyed per render and per recording, so a key never
// changes what it holds. The worker caches them for the same 30 days.
const UTILITY_LINEUP_FILE_CACHE = "public, max-age=2592000, immutable";

@Controller("/clips")
export class ClipDownloadController {
  constructor(
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly clips: ClipsService,
    private readonly logger: Logger,
  ) {}

  // A lineup's preview clip, thumbnail, stills and recorded smoke on a panel
  // with no Cloudflare worker: the path is the object's key, as it is on the
  // worker (utility_lineup_file_base_url).
  @Get("utility/*key")
  public async utilityLineupFile(
    @Param("key") path: string | Array<string>,
    @Query("name") name: string | undefined,
    @Query("dl") dl: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const key = `clips/utility/${[path].flat().join("/")}`;
    const extension = await this.utilityLineupFileExtension(key);
    if (!extension) {
      response.status(404).json({ error: "not found" });
      return;
    }
    await this.stream(
      key,
      UTILITY_LINEUP_FILE_TYPES[extension],
      name,
      dl === "1",
      request,
      response,
      UTILITY_LINEUP_FILE_CACHE,
    );
  }

  @Get(":clipId")
  public async download(
    @Param("clipId") clipId: string,
    @Query("name") name: string | undefined,
    @Query("dl") dl: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const clip = await this.getClip(clipId);
    if (!clip?.file) {
      response.status(404).json({ error: "not found" });
      return;
    }
    await this.stream(
      clip.file,
      "video/mp4",
      name,
      dl === "1",
      request,
      response,
    );
    if (
      this.shouldTrackView(request, clip.file) &&
      this.spansViewThreshold(response)
    ) {
      await this.registerView(request, clip.file);
    }
  }

  @Get(":clipId/thumbnail")
  public async thumbnail(
    @Param("clipId") clipId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const clip = await this.getClip(clipId);
    if (!clip?.thumbnail_url) {
      response.status(404).json({ error: "not found" });
      return;
    }
    await this.stream(
      clip.thumbnail_url,
      "image/jpeg",
      undefined,
      false,
      request,
      response,
    );
  }

  private shouldTrackView(request: Request, key: string): boolean {
    if (request.method !== "GET" || !/^clips\/.+\.mp4$/.test(key)) {
      return false;
    }
    if (
      request.query.dl === "1" ||
      request.query.download === "1" ||
      request.query.noview === "1"
    ) {
      return false;
    }
    return !BOT_UA.test(request.headers["user-agent"] ?? "");
  }

  private spansViewThreshold(response: Response): boolean {
    if (response.statusCode === 200) {
      return true;
    }
    // stream() sets Content-Range before it fetches the bytes, and a failed
    // fetch answers 500 with the header still set.
    if (response.statusCode !== 206) {
      return false;
    }
    const contentRange = response.getHeader("Content-Range");
    if (typeof contentRange !== "string") {
      return false;
    }
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
    if (!match) {
      return false;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isFinite(total) || total <= 0) {
      return false;
    }
    const threshold = total * VIEW_FRACTION;
    return start <= threshold && end >= threshold;
  }

  private async registerView(request: Request, file: string) {
    try {
      await this.clips.registerStreamedClipView(file, this.viewerKey(request));
    } catch (error) {
      this.logger.warn(
        `failed to count a view of ${file}: ${(error as Error)?.message}`,
      );
    }
  }

  private viewerKey(request: Request): string {
    const ip =
      (request.headers["cf-connecting-ip"] as string | undefined) ??
      request.ip ??
      "";
    const userAgent = request.headers["user-agent"] ?? "";
    return createHash("sha256")
      .update(`${ip}\n${userAgent}`)
      .digest("hex")
      .slice(0, 32);
  }

  private async getClip(clipId: string) {
    if (!/^[0-9a-fA-F-]{36}$/.test(clipId)) {
      return null;
    }
    const { match_clips_by_pk } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        file: true,
        thumbnail_url: true,
      },
    });
    return match_clips_by_pk;
  }

  // Only a file a lineup points at today, so the path being a key does not
  // open the rest of the bucket.
  private async utilityLineupFileExtension(
    key: string,
  ): Promise<string | null> {
    const match = UTILITY_LINEUP_FILE.exec(key);
    if (!match) {
      return null;
    }
    const [lineup] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id
         FROM public.utility_lineups
        WHERE id = $1::uuid
          AND ($2 IN (preview_file, preview_thumbnail, smoke_voxels_file)
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_each_text(COALESCE(preview_stills, '{}'::jsonb)) still
                  WHERE still.value = $2))`,
      [match[1], key],
    );
    return lineup ? match[2].toLowerCase() : null;
  }

  private async stream(
    key: string,
    contentType: string,
    downloadName: string | null | undefined,
    forceDownload: boolean,
    request: Request,
    response: Response,
    cacheControl = "private, max-age=0, must-revalidate",
  ) {
    let stat;
    try {
      stat = await this.s3.stat(key);
    } catch (error) {
      if ((error as { code?: string })?.code === "NotFound") {
        response.status(404).json({ error: "not found" });
        return;
      }
      this.logger.error(`failed to stat ${key}: ${(error as Error)?.message}`);
      response.status(500).json({ error: "internal" });
      return;
    }

    const size = stat.size;
    const safeName = (downloadName ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
    const dispositionType = forceDownload ? "attachment" : "inline";
    const disposition =
      safeName.length > 0
        ? `${dispositionType}; filename="${safeName}"`
        : dispositionType;

    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Disposition", disposition);
    response.setHeader("Accept-Ranges", "bytes");

    const rangeHeader = request.headers.range;
    const range = rangeHeader ? this.parseRange(rangeHeader, size) : null;

    if (rangeHeader && !range) {
      response.setHeader("Content-Range", `bytes */${size}`);
      response.status(416).end();
      return;
    }

    try {
      let stream: NodeJS.ReadableStream;
      if (range) {
        const length = range.end - range.start + 1;
        response.status(206);
        response.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
        response.setHeader("Content-Length", String(length));
        stream = await this.s3.getPartial(key, range.start, length);
      } else {
        response.status(200);
        response.setHeader("Content-Length", String(size));
        stream = await this.s3.get(key);
      }
      // Only once the bytes are in hand: a failed fetch answered under a
      // lineup file's policy would be cached as that file for a month.
      response.setHeader("Cache-Control", cacheControl);
      this.pipeWithCleanup(stream, response);
    } catch (error) {
      this.logger.error(
        `failed to stream ${key}: ${(error as Error)?.message}`,
      );
      if (!response.headersSent) {
        response.status(500).json({ error: "internal" });
      } else {
        response.destroy();
      }
    }
  }

  private parseRange(
    header: string,
    size: number,
  ): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const startStr = match[1];
    const endStr = match[2];
    let start: number;
    let end: number;
    if (startStr === "" && endStr === "") return null;
    if (startStr === "") {
      const suffix = parseInt(endStr, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr === "" ? size - 1 : parseInt(endStr, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < start || start >= size) return null;
    if (end >= size) end = size - 1;
    return { start, end };
  }

  private pipeWithCleanup(stream: NodeJS.ReadableStream, response: Response) {
    response.on("close", () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    });
    stream.pipe(response);
  }
}
