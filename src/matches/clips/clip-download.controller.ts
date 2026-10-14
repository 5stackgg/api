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
import { User } from "../../auth/types/User";
import { ClipsService } from "./clips.service";
import { FileUrlSigningService } from "../../hasura/file-url-signing.service";

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
// A public lineup's files are keyed per render and per recording, so a key
// never changes what it holds and a browser may keep it. Private, because a
// lineup can stop being public, and a cache shared between visitors would go
// on serving it past the check that refuses it here.
const PUBLIC_UTILITY_LINEUP_FILE_CACHE = "private, max-age=2592000, immutable";

@Controller("/clips")
export class ClipDownloadController {
  constructor(
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly clips: ClipsService,
    private readonly signing: FileUrlSigningService,
    private readonly logger: Logger,
  ) {}

  // A lineup's preview clip, thumbnail, stills and recorded smoke on a panel
  // with no Cloudflare worker: the path is the object's key, as it is on the
  // worker (utility_lineup_file_base_url). A link the computed fields signed is
  // served as the worker serves it. Without one, the session cookie spans the
  // web domain's subdomains, so a <video> or <img> on the page arrives here as
  // whoever is signed in, and a lineup is served to those who may see it.
  @Get("utility/*key")
  public async utilityLineupFile(
    @Param("key") path: string | Array<string>,
    @Query("name") name: string | undefined,
    @Query("dl") dl: string | undefined,
    @Query("exp") exp: string | undefined,
    @Query("sig") sig: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const key = `clips/utility/${[path].flat().join("/")}`;
    const file = await this.utilityLineupFileFor(
      key,
      request.user as User | undefined,
      this.signing.verify(key, exp, sig),
    );
    if (!file) {
      response.setHeader("Cache-Control", "no-store");
      response.status(404).json({ error: "not found" });
      return;
    }
    await this.stream(
      key,
      UTILITY_LINEUP_FILE_TYPES[file.extension],
      name,
      dl === "1",
      request,
      response,
      // What was served because of who asked is asked for again each time,
      // so signing out, or losing the lineup, takes it away.
      file.public ? PUBLIC_UTILITY_LINEUP_FILE_CACHE : undefined,
    );
  }

  // The demos domain carries no session, so the link itself is the grant: a
  // clip is served only on one the computed field signed (clip_download_url).
  @Get(":clipId")
  public async download(
    @Param("clipId") clipId: string,
    @Query("name") name: string | undefined,
    @Query("dl") dl: string | undefined,
    @Query("exp") exp: string | undefined,
    @Query("sig") sig: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const clip = await this.getClip(clipId);
    if (!clip?.file) {
      response.status(404).json({ error: "not found" });
      return;
    }
    if (!this.signing.verify(clip.file, exp, sig)) {
      this.refuse(response);
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
    @Query("exp") exp: string | undefined,
    @Query("sig") sig: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const clip = await this.getClip(clipId);
    if (!clip?.thumbnail_url) {
      response.status(404).json({ error: "not found" });
      return;
    }
    if (!this.signing.verify(clip.thumbnail_url, exp, sig)) {
      this.refuse(response);
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

  private refuse(response: Response) {
    response.setHeader("Cache-Control", "no-store");
    response.status(403).json({ error: "forbidden" });
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

  // Only a file that a lineup points at today, and only on a signed link or
  // to a viewer who may see that lineup, so the path being a key opens neither
  // the rest of the bucket nor a private lineup.
  private async utilityLineupFileFor(
    key: string,
    viewer: User | undefined,
    signed: boolean,
  ): Promise<{ extension: string; public: boolean } | null> {
    const match = UTILITY_LINEUP_FILE.exec(key);
    if (!match) {
      return null;
    }
    // The role Hasura would give them now. The session still holds the one
    // they signed in with, which a demoted moderator would keep for weeks.
    const session =
      viewer && !signed
        ? await this.hasura.getHasuraHeaders(viewer.steam_id)
        : {};
    const [lineup] = await this.postgres.query<Array<{ public: boolean }>>(
      `SELECT public.can_view_utility_lineup(l, '{}'::json) IS TRUE AS public
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid
          AND ($4::boolean OR public.can_view_utility_lineup(l, $3::json))
          AND ($2 IN (l.preview_file, l.preview_thumbnail, l.smoke_voxels_file)
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_each_text(COALESCE(l.preview_stills, '{}'::jsonb)) still
                  WHERE still.value = $2))`,
      [match[1], key, JSON.stringify(session), signed],
    );
    return lineup
      ? { extension: match[2].toLowerCase(), public: lineup.public }
      : null;
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
    // Until the bytes are in hand below: a failure answered under a lineup
    // file's policy would be cached as that file for a month.
    response.setHeader("Cache-Control", "no-store");

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
