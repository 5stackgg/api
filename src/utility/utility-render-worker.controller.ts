import { Controller, Logger, Param, Post, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { GameStreamerService } from "../matches/game-streamer/game-streamer.service";
import { UtilityRenderWorkerService } from "./utility-render-worker.service";

// The render pod's own route, keyed on the practice match it is connected to
// and authorized by that match's password -- the credential it joined with.
// Per-render routes (nade-renders/:jobId) carry a render's token instead, and
// a pod asking what to film next does not have one yet.
@Controller("nade-render-queue/:matchId")
export class UtilityRenderWorkerController {
  constructor(
    private readonly logger: Logger,
    private readonly worker: UtilityRenderWorkerService,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  @Post("next")
  public async next(
    @Param("matchId") matchId: string,
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
        `[nade-render-queue ${matchId}] next rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    try {
      return response.status(200).json(await this.worker.next(matchId));
    } catch (error) {
      this.logger.error(
        `[nade-render-queue ${matchId}] next failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }
  }
}
