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
import { NadeArtifactsService } from "./nade-artifacts.service";
import {
  NadeIngestPayload,
  NadeLineupsService,
  NadePracticeResultPayload,
  NadeServerContext,
} from "./nade-lineups.service";
import { NadePluginKeyGuard } from "./nade-plugin-key.guard";
import { NadePracticeService } from "./nade-practice.service";

@Controller("nades")
export class NadesController {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly lineups: NadeLineupsService,
    private readonly artifacts: NadeArtifactsService,
    private readonly practice: NadePracticeService,
  ) {}

  @Post("ingest")
  @UseGuards(NadePluginKeyGuard)
  public async ingest(
    @Req() request: Request,
    @Body() body: NadeIngestPayload,
  ) {
    await this.assertLibraryEnabled();

    // Measured before anything is parsed: a multi-megabyte path array is a
    // denial of service, not a lineup, and express has already accepted 50mb.
    const size = Buffer.byteLength(JSON.stringify(body ?? {}), "utf8");

    if (size > NadeLineupsService.MAX_PAYLOAD_BYTES) {
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
  @UseGuards(NadePluginKeyGuard)
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
  @UseGuards(NadePluginKeyGuard)
  public async session(@Req() request: Request) {
    const serverId = NadesController.serverId(request);

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
  // for the same reason GET /nades/session is: a server may only speak for the
  // session it is running. A session_id in the body is accepted so the plugin
  // can prove which session it thinks it is in, and rejected when it disagrees
  // -- it is never what the lookup keys on.
  @Post("practice-result")
  @UseGuards(NadePluginKeyGuard)
  public async practiceResult(
    @Req() request: Request,
    @Body() body: NadePracticeResultPayload,
  ) {
    await this.assertLibraryEnabled();

    const serverId = NadesController.serverId(request);
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

  @Post("provision-key")
  public async provisionKey(@Req() request: Request) {
    const user = request.user;

    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw new ForbiddenException();
    }

    const key = randomBytes(32).toString("hex");

    await this.postgres.query(
      `INSERT INTO public.settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [SystemSettingName.NadePluginApiKey, key],
    );

    this.logger.log(`nade plugin api key rotated by ${user.steam_id}`);

    // Practice pods read the key from their env, so a rotation only reaches a
    // server that boots after it.
    return { api_key: key };
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
      `SELECT public.can_view_nade_lineup(l, $2::json) AS visible,
              l.trajectory_file
         FROM public.nade_lineups l
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
  @UseGuards(NadePluginKeyGuard)
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

  // Set by NadePluginKeyGuard once it has matched the server's api_password.
  private static serverId(request: Request): string {
    return String(
      (request as Request & { nadeServerId?: string }).nadeServerId,
    );
  }

  private async context(request: Request): Promise<NadeServerContext> {
    const context = await this.lineups.serverContext(
      NadesController.serverId(request),
    );

    if (!context) {
      throw new BadRequestException("this server has no live match");
    }

    return context;
  }

  private async assertLibraryEnabled(): Promise<void> {
    if (!(await this.lineups.isLibraryEnabled())) {
      throw new ForbiddenException("the nade library is disabled");
    }
  }
}
