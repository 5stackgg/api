import {
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Req,
  Res,
  Body,
} from "@nestjs/common";
import { Request, Response } from "express";
import { PassThrough } from "node:stream";
import { ClipsService } from "./clips.service";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

@Controller("clip-renders/:jobId")
export class ClipRendersController {
  constructor(
    private readonly logger: Logger,
    private readonly clips: ClipsService,
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
    this.logger.log(
      `[clip ${jobId}] status POST: ${JSON.stringify(body ?? {})}`,
    );

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

    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      this.logger.warn(
        `[clip ${jobId}] upload rejected: content-length ${contentLength} > ${MAX_UPLOAD_BYTES}`,
      );
      return response
        .status(413)
        .json({ error: `upload too large (max ${MAX_UPLOAD_BYTES} bytes)` });
    }

    let received = 0;
    const counter = new PassThrough();
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        counter.destroy(
          new Error(
            `upload exceeded ${MAX_UPLOAD_BYTES} bytes (received ${received})`,
          ),
        );
        request.destroy();
      }
    });
    request.pipe(counter);

    try {
      const result = await this.clips.finalizeClipUpload(
        jobId,
        counter,
        durationMs,
      );
      response.status(201).json(result);
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] upload failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      const status = received > MAX_UPLOAD_BYTES ? 413 : 500;
      response.status(status).json({ error: (error as Error)?.message });
    }
  }
}
