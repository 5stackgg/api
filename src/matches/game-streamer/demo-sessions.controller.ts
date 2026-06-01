import {
  Body,
  Controller,
  Logger,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { GameStreamerService } from "./game-streamer.service";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";

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
}
