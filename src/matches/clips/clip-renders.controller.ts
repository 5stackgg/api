import {
  Controller,
  Get,
  Logger,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Req,
  Res,
  Body,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { ClipsService } from "./clips.service";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";
import { GameStreamerService } from "../game-streamer/game-streamer.service";

const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

@Controller("clip-renders/:jobId")
export class ClipRendersController {
  constructor(
    private readonly logger: Logger,
    private readonly clips: ClipsService,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  @Get("status")
  public async getStatus(
    @Param("jobId") jobId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.clips.validateClipRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      return response.status(401).end();
    }
    const row = await this.clips.getClipRenderStatus(jobId);
    if (!row) {
      return response.status(404).json({ error: "not found" });
    }
    return response.status(200).json({ status: row.status });
  }

  @Post("title")
  public async updateTitle(
    @Param("jobId") jobId: string,
    @Body() body: { title?: string },
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.clips.validateClipRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      return response.status(401).end();
    }
    const title = (body?.title ?? "").trim();
    if (title.length === 0 || title.length > 200) {
      return response.status(400).json({ error: "title required (≤200)" });
    }
    try {
      await this.clips.patchClipRenderTitle(jobId, title);
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] patchClipRenderTitle failed: ${(error as Error)?.message}`,
      );
      return response.status(500).json({ error: "internal" });
    }
    response.status(204).end();
  }

  @Post("status")
  public async reportStatus(
    @Param("jobId") jobId: string,
    @Body() body: ClipRenderStatusDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (body?.status !== "booting") {
      this.logger.log(
        `[clip ${jobId}] status POST: ${JSON.stringify(body ?? {})}`,
      );
    }

    const session = await this.clips.validateClipRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[clip ${jobId}] status POST rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    if (!body || typeof body.status !== "string" || body.status.length === 0) {
      return response.status(400).json({ error: "status required" });
    }

    try {
      await this.clips.reportClipRenderStatus(jobId, body);
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] reportClipRenderStatus failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    response.status(204).end();
  }

  @Post("upload")
  public async upload(
    @Param("jobId") jobId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.clips.validateClipRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[clip ${jobId}] upload rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    const durationHeader = request.headers["x-clip-duration-ms"];
    const durationMs = (() => {
      const n = Array.isArray(durationHeader)
        ? Number(durationHeader[0])
        : Number(durationHeader);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    })();

    try {
      const result = await this.clips.finalizeClipUpload(
        jobId,
        request,
        durationMs,
      );
      response.status(201).json(result);
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] upload failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      response.status(500).json({ error: (error as Error)?.message });
    }
  }

  @Post("snapshot")
  @UseInterceptors(FileInterceptor("file"))
  public async putSnapshot(
    @Param("jobId") jobId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: SNAPSHOT_MAX_BYTES })],
      }),
    )
    file: Express.Multer.File,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.clips.validateClipRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[clip ${jobId}] snapshot rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    try {
      await this.gameStreamer.storeSnapshot("clips", jobId, file.buffer);
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] storeSnapshot failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    return response.status(204).end();
  }

  @Post("thumbnail")
  public async thumbnail(
    @Param("jobId") jobId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.clips.validateClipRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[clip ${jobId}] thumbnail rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    try {
      const result = await this.clips.uploadClipThumbnail(jobId, request);
      response.status(201).json(result);
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] thumbnail upload failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      response.status(500).json({ error: (error as Error)?.message });
    }
  }
}
