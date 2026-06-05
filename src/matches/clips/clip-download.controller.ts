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
import { S3Service } from "../../s3/s3.service";
import { HasuraService } from "../../hasura/hasura.service";
import { ClipsService } from "./clips.service";

@Controller("/clips/:clipId")
export class ClipDownloadController {
  constructor(
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly clips: ClipsService,
    private readonly logger: Logger,
  ) {}

  @Get()
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
    if (dl !== "1" && this.isPlayStart(request)) {
      this.clips.incrementClipViews(clipId).catch((error) => {
        this.logger.warn(
          `failed to count play for clip ${clipId}: ${(error as Error)?.message}`,
        );
      });
    }
    await this.stream(
      clip.file,
      "video/mp4",
      name,
      dl === "1",
      request,
      response,
    );
  }

  @Get("thumbnail")
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

  private async stream(
    key: string,
    contentType: string,
    downloadName: string | null | undefined,
    forceDownload: boolean,
    request: Request,
    response: Response,
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
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

    const rangeHeader = request.headers.range;
    const range = rangeHeader ? this.parseRange(rangeHeader, size) : null;

    if (rangeHeader && !range) {
      response.setHeader("Content-Range", `bytes */${size}`);
      response.status(416).end();
      return;
    }

    try {
      if (range) {
        const length = range.end - range.start + 1;
        response.status(206);
        response.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
        response.setHeader("Content-Length", String(length));
        const stream = await this.s3.getPartial(key, range.start, length);
        this.pipeWithCleanup(stream, response);
      } else {
        response.status(200);
        response.setHeader("Content-Length", String(size));
        const stream = await this.s3.get(key);
        this.pipeWithCleanup(stream, response);
      }
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

  private isPlayStart(request: Request): boolean {
    const range = request.headers.range;
    if (!range) {
      return true;
    }
    return /^bytes=0-/.test(range.trim());
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
