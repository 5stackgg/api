import {
  Body,
  Controller,
  Logger,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Response } from "express";
import { GameStreamerService } from "./game-streamer.service";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";

const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

@Controller("demo-sessions/:sessionId")
export class DemoSessionsController {
  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  @Post("status")
  public async reportStatus(
    @Param("sessionId") sessionId: string,
    @Body() body: GameStreamerStatusDto,
    @Res() response: Response,
  ) {
    this.logger.log(
      `[demo ${sessionId}] status POST: ${JSON.stringify(body ?? {})}`,
    );

    if (!body || typeof body.status !== "string" || body.status.length === 0) {
      this.logger.warn(
        `[demo ${sessionId}] status POST rejected: missing status`,
      );
      return response.status(400).json({ error: "status required" });
    }

    try {
      await this.gameStreamer.reportDemoStatus(sessionId, body);
    } catch (error) {
      this.logger.error(
        `[demo ${sessionId}] reportDemoStatus failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    response.status(204).end();
  }

  // 1Hz state pushes from the pod's spec-server, fanned out to the
  // watcher; the per-viewer poll via demoControl("state") is the fallback.
  @Post("state")
  public async pushState(
    @Param("sessionId") sessionId: string,
    @Body() body: Record<string, unknown>,
    @Res() response: Response,
  ) {
    if (!body || typeof body !== "object") {
      return response.status(400).json({ error: "state body required" });
    }
    try {
      const known = await this.gameStreamer.pushDemoSessionState(
        sessionId,
        body,
      );
      if (!known) {
        // 404 tells the pod's pusher to stop warning.
        return response.status(404).json({ error: "unknown session" });
      }
    } catch (error) {
      this.logger.error(
        `[demo ${sessionId}] pushDemoSessionState failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    response.status(204).end();
  }

  @Post("snapshot")
  @UseInterceptors(FileInterceptor("file"))
  public async putSnapshot(
    @Param("sessionId") sessionId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: SNAPSHOT_MAX_BYTES })],
      }),
    )
    file: Express.Multer.File,
    @Res() response: Response,
  ) {
    try {
      await this.gameStreamer.storeSnapshot("demo", sessionId, file.buffer);
    } catch (error) {
      this.logger.error(
        `[demo ${sessionId}] storeSnapshot failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    return response.status(204).end();
  }
}
