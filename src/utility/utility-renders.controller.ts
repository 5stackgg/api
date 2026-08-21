import { Body, Controller, Get, Logger, Param, Post, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityRendersService } from "./utility-renders.service";
import { UtilityLaunchSeedService } from "./utility-launch-seed.service";
import { UtilityRenderStatusDto } from "./types/UtilityRenderStatusDto";

// The route the game-streamer's nade flow was written against
// (STATUS_API_BASE/nade-renders/:job_id/...). The table behind it is
// utility_lineup_renders; the path keeps the pod's name for it.
@Controller("nade-renders/:jobId")
export class UtilityRendersController {
  constructor(
    private readonly logger: Logger,
    private readonly renders: UtilityRendersService,
    private readonly launchSeeds: UtilityLaunchSeedService,
  ) {}

  // Publishing to the shared library is what books the render. Reviewed
  // through Hasura, so the event trigger is the only place that sees it land.
  @HasuraEvent()
  public async utility_lineup_render_events(
    data: HasuraEventData<{
      id: string;
      visibility: string;
      public_reviewed_by: string | null;
    }>,
  ) {
    if (data.new.visibility !== "Public" || data.old.visibility === "Public") {
      return;
    }

    const result = await this.renders.enqueue(String(data.new.id), {
      requestedBySteamId: data.new.public_reviewed_by
        ? String(data.new.public_reviewed_by)
        : null,
    });

    if (!result.queued) {
      this.logger.log(
        `[utility-render] ${data.new.id} not queued: ${result.reason}`,
      );
    }
  }

  @HasuraAction()
  public async renderUtilityLineupPreview(data: {
    user: User;
    utility_lineup_id: string;
  }) {
    if (!isRoleAbove(data.user?.role, "moderator")) {
      throw Error("only a moderator can re-render a preview");
    }

    const result = await this.renders.requeue(
      data.utility_lineup_id,
      data.user.steam_id,
    );

    return {
      success: result.queued,
      render_id: result.render_id,
      status: result.status,
      reason: result.reason,
    };
  }

  @HasuraAction()
  public async cancelUtilityLineupRender(data: {
    user: User;
    render_id: string;
  }) {
    if (!isRoleAbove(data.user?.role, "moderator")) {
      throw Error("only a moderator can cancel a render");
    }

    return { success: await this.renders.cancel(data.render_id) };
  }

  @HasuraAction()
  public async clearFinishedUtilityLineupRenders(data: { user: User }) {
    if (!isRoleAbove(data.user?.role, "administrator")) {
      throw Error("only an administrator can clear the render queue");
    }

    return { cleared: await this.renders.clearFinished() };
  }

  // One batch per call so a caller can watch it progress, same as the meta
  // re-mine. Only fills holes, so re-running it is free.
  @HasuraAction()
  public async backfillUtilityLaunchSeeds(data: {
    user: User;
    limit?: number;
  }) {
    if (!isRoleAbove(data.user?.role, "administrator")) {
      throw Error("only an administrator can backfill launch seeds");
    }

    return await this.launchSeeds.backfill(
      data.limit && data.limit > 0
        ? Math.min(data.limit, UtilityLaunchSeedService.BATCH)
        : UtilityLaunchSeedService.BATCH,
    );
  }

  // nade-clip.sh reads this once before it films: a job already cancelled is
  // skipped without touching the server.
  @Get("status")
  public async getStatus(
    @Param("jobId") jobId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.renders.validateRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      return response.status(401).end();
    }

    const row = await this.renders.getStatus(jobId);
    if (!row) {
      return response.status(404).json({ error: "not found" });
    }
    return response.status(200).json({ status: row.status });
  }

  @Post("status")
  public async reportStatus(
    @Param("jobId") jobId: string,
    @Body() body: UtilityRenderStatusDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.renders.validateRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[utility-render ${jobId}] status POST rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    if (!body || typeof body.status !== "string" || body.status.length === 0) {
      return response.status(400).json({ error: "status required" });
    }

    this.logger.log(
      `[utility-render ${jobId}] status POST: ${JSON.stringify(body)}`,
    );

    try {
      await this.renders.reportStatus(jobId, body);
    } catch (error) {
      this.logger.error(
        `[utility-render ${jobId}] reportStatus failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: "internal" });
    }

    return response.status(204).end();
  }

  @Post("thumbnail")
  public async thumbnail(
    @Param("jobId") jobId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.renders.validateRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      return response.status(401).end();
    }

    try {
      const result = await this.renders.uploadThumbnail(jobId, request);
      return response.status(201).json(result);
    } catch (error) {
      this.logger.error(
        `[utility-render ${jobId}] thumbnail upload failed: ${(error as Error)?.message}`,
      );
      return response.status(500).json({ error: (error as Error)?.message });
    }
  }

  // curl --upload-file with --request POST: the body arrives chunked and is
  // piped to S3 as it lands, never assembled in memory alongside the other
  // upload tails the batch has in flight.
  @Post("upload")
  public async upload(
    @Param("jobId") jobId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.renders.validateRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[utility-render ${jobId}] upload rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    const durationHeader = request.headers["x-clip-duration-ms"];
    const durationMs = (() => {
      const value = Array.isArray(durationHeader)
        ? Number(durationHeader[0])
        : Number(durationHeader);
      return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    })();

    try {
      const result = await this.renders.finalizeUpload(
        jobId,
        request,
        durationMs,
      );
      return response.status(201).json(result);
    } catch (error) {
      this.logger.error(
        `[utility-render ${jobId}] upload failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      return response.status(500).json({ error: (error as Error)?.message });
    }
  }
}
