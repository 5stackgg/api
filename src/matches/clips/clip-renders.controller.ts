import {
  Controller,
  Logger,
  Param,
  Post,
  Req,
  Res,
  Body,
} from "@nestjs/common";
import { Request, Response } from "express";
import { ClipsService } from "./clips.service";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";

// Pod-callback endpoints, mirroring DemoSessionsController. The render
// pod posts here with `x-origin-auth: <jobId>:<sessionToken>` to drive
// the clip_render_jobs row through queued → rendering → uploading →
// done. The upload endpoint accepts the rendered mp4 as the request
// body so the pod can stream a multi-hundred-MB file straight through
// the api into S3 without buffering in memory.
@Controller("clip-renders/:jobId")
export class ClipRendersController {
  constructor(
    private readonly logger: Logger,
    private readonly clips: ClipsService,
  ) {}

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

  // Raw streaming upload — the pod sends the mp4 as `application/octet-
  // stream` request body. We pipe it directly into S3 via the existing
  // s3.put() helper, which uses minio's chunked PutObject under the
  // hood. NestJS doesn't intercept the body for octet-stream by
  // default, so `request` arrives as the raw IncomingMessage stream.
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
}
