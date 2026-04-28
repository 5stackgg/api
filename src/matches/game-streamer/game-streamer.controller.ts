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

@Controller("game-streamer/:matchId")
export class GameStreamerController {
  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
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
      this.logger.warn(`[${matchId}] status POST rejected: invalid x-origin-auth`);
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
}
