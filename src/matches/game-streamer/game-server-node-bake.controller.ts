import {
  Body,
  Controller,
  Logger,
  MaxFileSizeValidator,
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
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";

const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

@Controller("game-server-nodes/:nodeId")
export class GameServerNodeBakeController {
  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  @Post("bake-status")
  public async reportBakeStatus(
    @Param("nodeId") nodeId: string,
    @Body() body: GameStreamerStatusDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (!body || typeof body.status !== "string" || body.status.length === 0) {
      return response.status(400).json({ error: "status required" });
    }

    const auth = request.headers["x-origin-auth"];
    if (auth !== nodeId) {
      this.logger.warn(`[bake ${nodeId}] bake-status POST rejected: bad auth`);
      return response.status(403).json({ error: "forbidden" });
    }

    try {
      await this.gameStreamer.reportBakeStatus(nodeId, body);
    } catch (error) {
      this.logger.error(
        `[bake ${nodeId}] reportBakeStatus failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    response.status(204).end();
  }

  @Post("snapshot")
  @UseInterceptors(FileInterceptor("file"))
  public async putSnapshot(
    @Param("nodeId") nodeId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: SNAPSHOT_MAX_BYTES })],
      }),
    )
    file: Express.Multer.File,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const auth = request.headers["x-origin-auth"];
    if (auth !== nodeId) {
      this.logger.warn(`[bake ${nodeId}] snapshot POST rejected: bad auth`);
      return response.status(403).json({ error: "forbidden" });
    }

    try {
      await this.gameStreamer.storeSnapshot("bake", nodeId, file.buffer);
    } catch (error) {
      this.logger.error(
        `[bake ${nodeId}] storeSnapshot failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
    return response.status(204).end();
  }
}
