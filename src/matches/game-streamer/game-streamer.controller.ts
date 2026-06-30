import {
  Body,
  Controller,
  Get,
  Logger,
  MaxFileSizeValidator,
  NotFoundException,
  Param,
  ParseFilePipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { GameStreamerService } from "./game-streamer.service";
import { StreamAccessService } from "./stream-access.service";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";

const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

@Controller("game-streamer/:matchId")
export class GameStreamerController {
  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
    private readonly streamAccess: StreamAccessService,
  ) {}

  @Post("status")
  public async reportStatus(
    @Param("matchId") matchId: string,
    @Body() body: GameStreamerStatusDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.logger.log(`[${matchId}] status POST: ${JSON.stringify(body ?? {})}`);

    if (
      !(await this.gameStreamer.validateStatusOriginAuth(
        matchId,
        request.headers["x-origin-auth"],
      ))
    ) {
      this.logger.warn(
        `[${matchId}] status POST rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    if (!body || typeof body.status !== "string" || body.status.length === 0) {
      this.logger.warn(`[${matchId}] status POST rejected: missing status`);
      return response.status(400).json({ error: "status required" });
    }

    try {
      await this.gameStreamer.reportStatus(matchId, body);
    } catch (error) {
      this.logger.error(
        `[${matchId}] reportStatus failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    response.status(204).end();
  }

  @Post("snapshot")
  @UseInterceptors(FileInterceptor("file"))
  public async putSnapshot(
    @Param("matchId") matchId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: SNAPSHOT_MAX_BYTES })],
      }),
    )
    file: Express.Multer.File,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (
      !(await this.gameStreamer.validateStatusOriginAuth(
        matchId,
        request.headers["x-origin-auth"],
      ))
    ) {
      this.logger.warn(
        `[${matchId}] snapshot POST rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    try {
      await this.gameStreamer.storeSnapshot("live", matchId, file.buffer);
    } catch (error) {
      this.logger.error(
        `[${matchId}] storeSnapshot failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    return response.status(204).end();
  }

  @Get("snapshot")
  public async getSnapshot(
    @Param("matchId") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const requireLogin = await this.streamAccess.requireLoginForLiveStreams();
    if (requireLogin && !(await this.streamAccess.authorize(request, matchId))) {
      return response.status(403).end();
    }

    const image = await this.gameStreamer.getSnapshot("live", matchId);
    if (!image) {
      throw new NotFoundException("no snapshot available");
    }
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader(
      "Cache-Control",
      requireLogin ? "private, max-age=15" : "public, max-age=15",
    );
    response.setHeader("Content-Length", String(image.length));
    return response.status(200).end(image);
  }
}
