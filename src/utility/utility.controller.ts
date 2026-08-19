import { randomBytes } from "crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { ApiKeyGuard } from "../auth/strategies/ApiKeyGuard";
import { PostgresService } from "../postgres/postgres.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityArtifactsService } from "./utility-artifacts.service";
import {
  UtilityIngestPayload,
  UtilityLineupsService,
  UtilityPracticeResultPayload,
  UtilityServerContext,
} from "./utility-lineups.service";
import { UtilityPluginKeyGuard } from "./utility-plugin-key.guard";
import { UtilityPracticeService } from "./utility-practice.service";

@Controller("utility")
export class UtilityController {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly lineups: UtilityLineupsService,
    private readonly artifacts: UtilityArtifactsService,
    private readonly practice: UtilityPracticeService,
  ) {}

  @Post("ingest")
  @UseGuards(UtilityPluginKeyGuard)
  public async ingest(
    @Req() request: Request,
    @Body() body: UtilityIngestPayload,
  ) {
    await this.assertLibraryEnabled();

    // Measured before anything is parsed: a multi-megabyte path array is a
    // denial of service, not a lineup, and express has already accepted 50mb.
    const size = Buffer.byteLength(JSON.stringify(body ?? {}), "utf8");

    if (size > UtilityLineupsService.MAX_PAYLOAD_BYTES) {
      throw new BadRequestException("payload too large");
    }

    const context = await this.context(request);

    try {
      return await this.lineups.ingest(context, body);
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "invalid lineup",
      );
    }
  }

  @Get("library")
  @UseGuards(UtilityPluginKeyGuard)
  public async library(
    @Req() request: Request,
    @Query("steam_id") steamId: string,
  ) {
    await this.assertLibraryEnabled();

    const context = await this.context(request);

    try {
      return {
        map_name: context.mapName,
        lineups: await this.lineups.library(context, String(steamId ?? "")),
      };
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "invalid request",
      );
    }
  }

  // How a practice server learns who is allowed to connect: with no match
  // plugin on the pod, the InitConnect gate lives in the practice plugin
  // instead, and this is where it gets its roster and password.
  //
  // The session is resolved from the authenticated server and never from a
  // parameter. A server that could name a session id could read a session it
  // is not running -- and the match password is what gets you onto that
  // server.
  @Get("session")
  @UseGuards(UtilityPluginKeyGuard)
  public async session(@Req() request: Request) {
    const serverId = UtilityController.serverId(request);

    const session = await this.practice.sessionForServer(serverId);

    if (!session) {
      throw new NotFoundException(
        "this server is not running a practice session",
      );
    }

    // The plugin asking at all is the definitive signal that the server is up.
    await this.practice.markReady(session.match_id);

    return session;
  }

  // Scores one throw. The session is resolved from the authenticated server
  // for the same reason GET /utility/session is: a server may only speak for the
  // session it is running. A session_id in the body is accepted so the plugin
  // can prove which session it thinks it is in, and rejected when it disagrees
  // -- it is never what the lookup keys on.
  @Post("practice-result")
  @UseGuards(UtilityPluginKeyGuard)
  public async practiceResult(
    @Req() request: Request,
    @Body() body: UtilityPracticeResultPayload,
  ) {
    await this.assertLibraryEnabled();

    const serverId = UtilityController.serverId(request);
    const session = await this.practice.liveSessionForServer(serverId);

    if (!session) {
      throw new NotFoundException(
        "this server is not running a practice session",
      );
    }

    if (body?.session_id && String(body.session_id) !== session.session_id) {
      throw new ForbiddenException("that is not this server's session");
    }

    const context = await this.context(request);

    try {
      return await this.lineups.recordPracticeResult(context, body);
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "invalid result",
      );
    }
  }

  @Get(":lineupId/trajectory")
  @UseGuards(ApiKeyGuard)
  public async trajectory(
    @Req() request: Request,
    @Param("lineupId") lineupId: string,
  ): Promise<StreamableFile> {
    const steamId = request.user?.steam_id ?? null;

    const [row] = await this.postgres.query<
      Array<{ visible: boolean; trajectory_file: string | null }>
    >(
      `SELECT public.can_view_utility_lineup(l, $2::json) AS visible,
              l.trajectory_file
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid`,
      [
        lineupId,
        JSON.stringify({
          "x-hasura-role": request.user?.role ?? "guest",
          ...(steamId ? { "x-hasura-user-id": steamId } : {}),
        }),
      ],
    );

    if (!row || !row.visible) {
      throw new NotFoundException("lineup not found");
    }

    if (
      !row.trajectory_file ||
      !(await this.artifacts.hasTrajectory(row.trajectory_file))
    ) {
      throw new NotFoundException("trajectory missing");
    }

    return new StreamableFile(
      await this.artifacts.readTrajectory(row.trajectory_file),
    );
  }

  @Delete(":id")
  @UseGuards(UtilityPluginKeyGuard)
  public async remove(
    @Req() request: Request,
    @Param("id") id: string,
    @Query("steam_id") steamId: string,
  ) {
    const context = await this.context(request);
    const author = String(steamId ?? "");

    if (!context.lineupSteamIds.includes(author)) {
      throw new ForbiddenException("player is not in this match lineup");
    }

    try {
      await this.lineups.deleteLineup(id, author);
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "unable to delete",
      );
    }

    return { success: true };
  }

  // Set by UtilityPluginKeyGuard once it has matched the server's api_password.
  private static serverId(request: Request): string {
    return String(
      (request as Request & { utilityServerId?: string }).utilityServerId,
    );
  }

  private async context(request: Request): Promise<UtilityServerContext> {
    const context = await this.lineups.serverContext(
      UtilityController.serverId(request),
    );

    if (!context) {
      throw new BadRequestException("this server has no live match");
    }

    return context;
  }

  private async assertLibraryEnabled(): Promise<void> {
    if (!(await this.lineups.isLibraryEnabled())) {
      throw new ForbiddenException("the utility library is disabled");
    }
  }
}
