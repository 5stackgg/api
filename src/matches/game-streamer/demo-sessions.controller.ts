import {
  Body,
  Controller,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import { GameStreamerService } from "./game-streamer.service";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";

// Status receiver for per-user demo playback pods. Mirrors
// /game-streamer/:matchId/status but writes to match_demo_sessions
// instead of match_streams, and authenticates with the per-session
// token issued at job spawn (no shared match password to validate
// against — demos run on finished matches whose passwords have
// rotated or are otherwise unsuitable for streamer-pod auth).
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
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.logger.log(
      `[demo ${sessionId}] status POST: ${JSON.stringify(body ?? {})}`,
    );

    const session = await this.gameStreamer.validateDemoSessionAuth(
      sessionId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[demo ${sessionId}] status POST rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

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
}
