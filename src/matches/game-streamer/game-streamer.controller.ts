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

    // MatchRelayAuthMiddleware authenticates on the matchId in the
    // x-origin-auth header. Reject if the URL matchId disagrees so a
    // pod with one match's password can't write into a different
    // match's row.
    const originAuth = request.headers["x-origin-auth"];
    const headerMatchId =
      typeof originAuth === "string"
        ? originAuth.substring(0, originAuth.indexOf(":"))
        : "";
    if (headerMatchId !== matchId) {
      this.logger.warn(
        `[${matchId}] status POST rejected: x-origin-auth matchId="${headerMatchId}" does not match URL matchId`,
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
}
