import {
  Body,
  Controller,
  Get,
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
import { GameStreamerService } from "../matches/game-streamer/game-streamer.service";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityPracticeService } from "./utility-practice.service";
import { UtilityRendersService } from "./utility-renders.service";
import { UtilityLaunchSeedService } from "./utility-launch-seed.service";
import { UtilityRenderStatusDto } from "./types/UtilityRenderStatusDto";

const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

// The route the game-streamer's nade flow was written against
// (STATUS_API_BASE/nade-renders/:job_id/...). The table behind it is
// utility_lineup_renders; the path keeps the pod's name for it.
@Controller("nade-renders/:jobId")
export class UtilityRendersController {
  constructor(
    private readonly logger: Logger,
    private readonly renders: UtilityRendersService,
    private readonly launchSeeds: UtilityLaunchSeedService,
    private readonly gameStreamer: GameStreamerService,
    private readonly practice: UtilityPracticeService,
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

    const result = await this.renders.cancel(data.render_id);

    // Cancelling the last render in the queue is cancelling the batch: nothing
    // is coming for the practice server any more, and a booked GPU server
    // idling until the batch job's next tick noticed was the reviewer's
    // problem to watch. Tear both down here; the batch job's own release is
    // the backstop and every step of it is idempotent. With anything else
    // still queued, on any map, the pod and its server are that render's next.
    if (result.cancelled) {
      const remaining = await this.renders.inFlight();
      if (remaining.length === 0) {
        if (result.jobName) {
          await this.gameStreamer.killNadeRenderPod(result.jobName);
        }
        if (result.sessionId) {
          await this.practice.endRenderSession(result.sessionId);
        }
      }
    }

    return { success: result.cancelled };
  }

  @HasuraAction()
  public async deleteUtilityLineupRender(data: {
    user: User;
    render_id: string;
  }) {
    if (!isRoleAbove(data.user?.role, "moderator")) {
      throw Error("only a moderator can delete a render");
    }

    return { success: await this.renders.deletePreview(data.render_id) };
  }

  @HasuraAction()
  public async clearFinishedUtilityLineupRenders(data: { user: User }) {
    if (!isRoleAbove(data.user?.role, "administrator")) {
      throw Error("only an administrator can clear the render queue");
    }

    return { cleared: await this.renders.clearFinished() };
  }

  // What the render queue page shows above the queue: which public lineups
  // have no preview, and which have one an older render version filmed.
  @HasuraAction()
  public async utilityLineupRenderCoverage(data: {
    user: User;
    map_name?: string | null;
  }) {
    if (!isRoleAbove(data.user?.role, "moderator")) {
      throw Error("only a moderator can see what the previews are missing");
    }

    return await this.renders.coverage(data.map_name || null);
  }

  @HasuraAction()
  public async renderUtilityLineupPreviews(data: {
    user: User;
    scope: string;
    map_name?: string | null;
  }) {
    if (!isRoleAbove(data.user?.role, "moderator")) {
      throw Error("only a moderator can queue preview renders");
    }

    if (
      data.scope !== "missing" &&
      data.scope !== "outdated" &&
      data.scope !== "all"
    ) {
      throw Error("scope must be missing, outdated or all");
    }

    return await this.renders.enqueueGaps(data.scope, {
      mapName: data.map_name || null,
      requestedBySteamId: data.user.steam_id,
    });
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

    this.logger.debug(
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

  // snapshot.sh fans a frame of the pod's screen out to every job in the
  // batch (the same _snapshot_targets the clip batch uses), so a reviewer can
  // see what the pod is looking at while it boots and films. Redis-held, 75s
  // TTL; read back through GET /snapshots/nades/:id.
  @Post("snapshot")
  @UseInterceptors(FileInterceptor("file"))
  public async putSnapshot(
    @Param("jobId") jobId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: SNAPSHOT_MAX_BYTES })],
      }),
    )
    file: Express.Multer.File,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.renders.validateRenderAuth(
      jobId,
      request.headers["x-origin-auth"],
    );
    if (!session) {
      this.logger.warn(
        `[utility-render ${jobId}] snapshot rejected: invalid x-origin-auth`,
      );
      return response.status(401).end();
    }

    try {
      await this.gameStreamer.storeSnapshot("nades", jobId, file.buffer);
    } catch (error) {
      this.logger.error(
        `[utility-render ${jobId}] storeSnapshot failed: ${(error as Error)?.message}`,
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

  @Post("still/:kind")
  public async still(
    @Param("jobId") jobId: string,
    @Param("kind") kind: string,
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

    if (!UtilityRendersService.isStill(kind)) {
      return response.status(400).json({ error: `unknown still ${kind}` });
    }

    try {
      const result = await this.renders.uploadStill(
        jobId,
        kind,
        request,
        request.headers["content-type"],
      );
      return response.status(201).json(result);
    } catch (error) {
      this.logger.error(
        `[utility-render ${jobId}] ${kind} still upload failed: ${(error as Error)?.message}`,
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

    // What the director said it filmed with. A pod from before renders were
    // versioned sends nothing, and its preview is recorded as unversioned.
    const versionHeader = request.headers["x-render-version"];
    const renderVersion = (() => {
      const value = Number(
        Array.isArray(versionHeader) ? versionHeader[0] : versionHeader,
      );
      return Number.isInteger(value) && value > 0 && value < 100_000
        ? value
        : null;
    })();

    try {
      const result = await this.renders.finalizeUpload(
        jobId,
        request,
        durationMs,
        renderVersion,
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
